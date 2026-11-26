/** A scoped imported record; id is the DB key, sourceRecordId the dataset's external ID. */
export type SourceRow = {
  id: string;
  sourceRecordId: string;
  assetId: string;
  datasetId: string;
  canonicalJson?: string | null;
  question: string | null;
  choicesJson: string | null;
  metadataJson: string;
  updatedAt: string;
};

/** Original imported labels, never worker annotation revisions or accepted workflow output. */
export type LabelRow = {
  id: string;
  kind: "reference_answer" | "early_annotation";
  payloadJson: string;
  provenance: string;
  updatedAt: string;
};

export const sourceFieldRepository = {
  /**
   * Resolve record identity through project -> dataset -> asset -> source record.
   *
   * External record IDs are unique only within an asset. With no assetId, retain
   * T01's compatibility lookup but return up to two matches so the service can
   * refuse ambiguity. All request values are bound, including the optional asset.
   */
  async find(
    db: D1Database,
    projectId: string,
    datasetId: string,
    recordId: string,
    assetId?: string,
  ): Promise<SourceRow[]> {
    const rows = await db
      .prepare(`SELECT sr.id, sr.source_record_id AS sourceRecordId,
        sr.asset_id AS assetId, a.dataset_id AS datasetId,
        sr.canonical_json AS canonicalJson, sr.question, sr.choices_json AS choicesJson,
        sr.metadata_json AS metadataJson, sr.updated_at AS updatedAt
        FROM source_records sr
        JOIN audio_assets a ON a.id = sr.asset_id
        JOIN datasets d ON d.id = a.dataset_id
        WHERE d.project_id = ? AND d.id = ? AND sr.source_record_id = ?
          AND (? IS NULL OR a.id = ?)
        LIMIT 2`)
      .bind(projectId, datasetId, recordId, assetId ?? null, assetId ?? null)
      .all<SourceRow>();
    return rows.results;
  },

  /** Bulk public-projection input for research exports of older static tasks.
   * Scope every ID through its project/dataset; chunks stay under D1's bind
   * limit and avoid one metadata query per audio. Labels are never joined.
   */
  async forIds(db:D1Database,projectId:string,datasetId:string,ids:string[]):Promise<SourceRow[]> {
    const rows:SourceRow[]=[];
    for(let start=0;start<ids.length;start+=80){
      const chunk=ids.slice(start,start+80);
      rows.push(...(await db.prepare(`SELECT sr.id,sr.source_record_id AS sourceRecordId,sr.asset_id AS assetId,a.dataset_id AS datasetId,
        sr.canonical_json AS canonicalJson,sr.question,sr.choices_json AS choicesJson,sr.metadata_json AS metadataJson,sr.updated_at AS updatedAt
        FROM source_records sr JOIN audio_assets a ON a.id=sr.asset_id JOIN datasets d ON d.id=a.dataset_id
        WHERE d.project_id=? AND d.id=? AND sr.id IN (${chunk.map(()=>"?").join(",")})`).bind(projectId,datasetId,...chunk).all<SourceRow>()).results);
    }
    return rows;
  },

  /** Check the persisted project role; caller-supplied role alone grants nothing. */
  async role(db: D1Database, projectId: string, userId: string): Promise<string | null> {
    const member = await db
      .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(projectId, userId)
      .first<{ role: string }>();
    return member?.role ?? null;
  },

  /** Read labels only after the service has scoped the record and verified admin view. */
  async labels(db: D1Database, sourceId: string): Promise<LabelRow[]> {
    const rows = await db
      .prepare(`SELECT id, kind, payload_json AS payloadJson, provenance,
        updated_at AS updatedAt
        FROM source_labels WHERE source_record_id = ? ORDER BY kind`)
      .bind(sourceId)
      .all<LabelRow>();
    return rows.results;
  },
};
