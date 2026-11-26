/** Private provenance lives here; public projection is the service's responsibility. */
export type CandidateSetRow = {
  id: string; taskInstanceId: string; blockId: string; requestId: string;
  requestFingerprint: string; createdBy: string; entryCount: number; allowSelfVote: number;
};
/** Immutable candidate observation, with exactly one real source reference. */
export type CandidateEntryRow = {
  id: string; candidateSetId: string; position: number; sourceKind: "dataset_annotation" | "submission" | "curated";
  sourceLabelId: string | null; sourceRevisionId: string | null; curatedCandidateId: string | null;
  sourceFieldId: string; sourceRecordDbId: string | null; sourceTaskInstanceId: string | null;
  sourceDefinitionId: string | null; sourceDefinitionVersion: number | null;
  sourceAuthorId: string | null; sourceUpdatedAt: string; valueJson: string;
};
export type CandidateTargetRow = {
  id: string; projectId: string; assetId: string; sourceRecordDbId: string | null;
  definitionJson: string; definitionId: string; definitionVersion: number;
  assetProjectId: string; definitionProjectId: string; sourceAssetId: string | null; extraAudio: number;
};
export type CandidateSubmissionRow = {
  id: string; status: string; authorId: string; projectId: string; assetId: string;
  sourceRecordDbId: string | null; taskInstanceId: string; definitionId: string;
  definitionVersion: number; definitionJson: string; answersJson: string; createdAt: string; extraAudio: number;
};
export type CandidateLabelRow = {
  id: string; kind: string; sourceRecordDbId: string; assetId: string;
  projectId: string; payloadJson: string; updatedAt: string;
};
export type CuratedCandidateRow = { id: string; projectId: string; assetId: string; label: string; createdAt: string };

const selectSet = `SELECT id,task_instance_id AS taskInstanceId,block_id AS blockId,
  request_id AS requestId,request_fingerprint AS requestFingerprint,
  created_by AS createdBy,entry_count AS entryCount,allow_self_vote AS allowSelfVote FROM candidate_set_snapshots`;
const selectEntry = `SELECT e.id,e.candidate_set_id AS candidateSetId,e.position,
  e.source_kind AS sourceKind,e.source_label_id AS sourceLabelId,
  e.source_revision_id AS sourceRevisionId,e.curated_candidate_id AS curatedCandidateId,
  e.source_field_id AS sourceFieldId,e.source_record_db_id AS sourceRecordDbId,
  e.source_task_instance_id AS sourceTaskInstanceId,e.source_definition_id AS sourceDefinitionId,
  e.source_definition_version AS sourceDefinitionVersion,e.source_author_id AS sourceAuthorId,
  e.source_updated_at AS sourceUpdatedAt,e.value_json AS valueJson FROM candidate_set_entries e`;

/** Bound placeholders are generated from array length; IDs are never interpolated into SQL. */
const holders = (ids: string[]) => ids.map(() => "?").join(",");

export const candidateSetRepository = {
  /** Verify the persisted local role; a supplied role toggle grants no permission. */
  async role(db: D1Database, projectId: string, userId: string) {
    return (await db.prepare("SELECT role FROM project_members WHERE project_id=? AND user_id=?")
      .bind(projectId,userId).first<{ role: string }>())?.role ?? null;
  },
  /** Resolve the immutable published voting block and its exact audio/source relationship. */
  async target(db: D1Database, id: string) {
    return db.prepare(`SELECT t.id,t.project_id AS projectId,t.asset_id AS assetId,
      t.source_record_db_id AS sourceRecordDbId,t.definition_id AS definitionId,
      t.definition_version AS definitionVersion,v.definition_json AS definitionJson,
      d.project_id AS assetProjectId,def.project_id AS definitionProjectId,sr.asset_id AS sourceAssetId,
      (SELECT COUNT(*) FROM task_instance_audio_slots x WHERE x.task_instance_id=t.id AND x.asset_id<>t.asset_id) AS extraAudio
      FROM task_instances t JOIN audio_assets a ON a.id=t.asset_id JOIN datasets d ON d.id=a.dataset_id
      JOIN task_definitions def ON def.id=t.definition_id
      LEFT JOIN source_records sr ON sr.id=t.source_record_db_id
      JOIN task_definition_versions v ON v.definition_id=t.definition_id AND v.version=t.definition_version
      WHERE t.id=?`).bind(id).first<CandidateTargetRow>();
  },
  /** Read only selected source IDs in at most three bulk queries, never one query per candidate. */
  async labels(db: D1Database, ids: string[]): Promise<CandidateLabelRow[]> {
    if (!ids.length) return [];
    return (await db.prepare(`SELECT l.id,l.kind,l.source_record_id AS sourceRecordDbId,
      l.payload_json AS payloadJson,l.updated_at AS updatedAt,s.asset_id AS assetId,d.project_id AS projectId
      FROM source_labels l JOIN source_records s ON s.id=l.source_record_id
      JOIN audio_assets a ON a.id=s.asset_id JOIN datasets d ON d.id=a.dataset_id
      WHERE l.id IN (${holders(ids)})`).bind(...ids).all<CandidateLabelRow>()).results;
  },
  async submissions(db: D1Database, ids: string[]): Promise<CandidateSubmissionRow[]> {
    if (!ids.length) return [];
    return (await db.prepare(`SELECT r.id,r.status,r.labeller_user_id AS authorId,r.answers_json AS answersJson,
      r.created_at AS createdAt,t.project_id AS projectId,t.asset_id AS assetId,
      t.source_record_db_id AS sourceRecordDbId,t.id AS taskInstanceId,t.definition_id AS definitionId,
      t.definition_version AS definitionVersion,v.definition_json AS definitionJson,
      (SELECT COUNT(*) FROM task_instance_audio_slots x WHERE x.task_instance_id=t.id AND x.asset_id<>t.asset_id) AS extraAudio
      FROM annotation_revisions r JOIN assignments a ON a.id=r.assignment_id
      JOIN task_instances t ON t.id=a.task_instance_id
      JOIN task_definitions def ON def.id=t.definition_id AND def.project_id=t.project_id
      JOIN task_definition_versions v ON v.definition_id=t.definition_id AND v.version=t.definition_version
      WHERE r.id IN (${holders(ids)}) AND a.project_id=t.project_id AND a.labeller_user_id=r.labeller_user_id`)
      .bind(...ids).all<CandidateSubmissionRow>()).results;
  },
  async curated(db: D1Database, ids: string[]): Promise<CuratedCandidateRow[]> {
    if (!ids.length) return [];
    return (await db.prepare(`SELECT id,project_id AS projectId,asset_id AS assetId,label,created_at AS createdAt
      FROM annotation_candidates WHERE id IN (${holders(ids)})`).bind(...ids).all<CuratedCandidateRow>()).results;
  },
  /** Admin inventory is bounded and scoped to the exact voting item. */
  async availableSources(db: D1Database, target: CandidateTargetRow) {
    const [labels, revisions, curated] = await Promise.all([
      db
        .prepare(
          "SELECT id FROM source_labels WHERE source_record_id=? AND kind='early_annotation' ORDER BY id LIMIT 100",
        )
        .bind(target.sourceRecordDbId)
        .all<{ id: string }>(),
      db
        .prepare(
          `SELECT r.id FROM annotation_revisions r JOIN assignments a ON a.id=r.assignment_id
        JOIN task_instances t ON t.id=a.task_instance_id
        WHERE r.status='submitted' AND t.project_id=? AND t.asset_id=? AND t.source_record_db_id IS ? AND t.id<>?
        ORDER BY r.created_at DESC,r.id LIMIT 100`,
        )
        .bind(
          target.projectId,
          target.assetId,
          target.sourceRecordDbId,
          target.id,
        )
        .all<{ id: string }>(),
      db
        .prepare(
          "SELECT id FROM annotation_candidates WHERE project_id=? AND asset_id=? ORDER BY id LIMIT 100",
        )
        .bind(target.projectId, target.assetId)
        .all<{ id: string }>(),
    ]);
    return {
      labels: await this.labels(
        db,
        labels.results.map((r) => r.id),
      ),
      revisions: await this.submissions(
        db,
        revisions.results.map((r) => r.id),
      ),
      curated: await this.curated(
        db,
        curated.results.map((r) => r.id),
      ),
    };
  },
  async byId(db: D1Database, id: string) {
    return db
      .prepare(`${selectSet} WHERE id=?`)
      .bind(id)
      .first<CandidateSetRow>();
  },
  /** One lookup for all closed sets on the opened job; no per-block query. */
  async closed(db: D1Database, taskId: string) {
    return (
      await db
        .prepare(
          `SELECT r.candidate_set_id AS id FROM candidate_vote_results r
      JOIN candidate_set_snapshots s ON s.id=r.candidate_set_id WHERE s.task_instance_id=? AND r.status='accepted'`,
        )
        .bind(taskId)
        .all<{ id: string }>()
    ).results.map((r) => r.id);
  },
  async find(db: D1Database, taskId: string, blockId: string) {
    return db.prepare(`${selectSet} WHERE task_instance_id=? AND block_id=?`).bind(taskId,blockId).first<CandidateSetRow>();
  },
  async sets(db: D1Database, taskId: string) {
    return (await db.prepare(`${selectSet} WHERE task_instance_id=? ORDER BY block_id`)
      .bind(taskId).all<CandidateSetRow>()).results;
  },
  async entries(db: D1Database, taskId: string) {
    return (await db.prepare(`${selectEntry} JOIN candidate_set_snapshots s ON s.id=e.candidate_set_id
      WHERE s.task_instance_id=? ORDER BY e.candidate_set_id,e.position`)
      .bind(taskId).all<CandidateEntryRow>()).results;
  },
  /**
   * Commit set and entries in one D1 transaction. A competing creator can only
   * win once; WHERE EXISTS prevents orphan/duplicate entries for a losing UUID.
   * Retry decisions use the stored request fingerprint in the service.
   */
  async insert(db: D1Database, set: CandidateSetRow, entries: CandidateEntryRow[]) {
    const statements = [db.prepare(`INSERT INTO candidate_set_snapshots
      (id,task_instance_id,block_id,request_id,request_fingerprint,created_by,entry_count,allow_self_vote)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_instance_id,block_id) DO NOTHING`)
      .bind(set.id,set.taskInstanceId,set.blockId,set.requestId,set.requestFingerprint,set.createdBy,set.entryCount,set.allowSelfVote)];
    for (const entry of entries) statements.push(db.prepare(`INSERT INTO candidate_set_entries
      (id,candidate_set_id,position,source_kind,source_label_id,source_revision_id,curated_candidate_id,
       source_field_id,source_record_db_id,source_task_instance_id,source_definition_id,source_definition_version,
       source_author_id,source_updated_at,value_json)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM candidate_set_snapshots WHERE id=?)`)
      .bind(entry.id,set.id,entry.position,entry.sourceKind,entry.sourceLabelId,entry.sourceRevisionId,entry.curatedCandidateId,
        entry.sourceFieldId,entry.sourceRecordDbId,entry.sourceTaskInstanceId,entry.sourceDefinitionId,entry.sourceDefinitionVersion,
        entry.sourceAuthorId,entry.sourceUpdatedAt,entry.valueJson,set.id));
    const result = await db.batch(statements);
    return result[0].meta.changes === 1;
  },
};
