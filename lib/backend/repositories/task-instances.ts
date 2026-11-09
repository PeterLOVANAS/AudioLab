/**
 * Task Instances — D1 REPOSITORY.
 * This file contains SQL only. It doesn't decide HTTP status codes.
 * All user-supplied values are bound using '?' placeholders to avoid SQL
 * injection. `.first<T>()` returns a row or null; `.all<T>().results` an array.
 */

/** Data returned by a SELECT. SQL aliases convert snake_case to camelCase. */
export type TaskInstanceRow = {
  id: string;
  projectId: string;
  assetId: string;
  originalPath: string;
  definitionId: string;
  definitionVersion: number;
  definitionName: string;
  definitionJson: string; // frozen published protocol as JSON TEXT
  sourceRecordId: string | null;
  sourceQuestion: string | null;
  sourceChoicesJson: string | null;
  createdAt: string;
};

// LEFT JOIN allows audio-only tasks that have NO associated MMAU question.
// Importantly, source_labels is NEVER joined: correct benchmark answers
// must not appear in the Labeller task preview or API response.
const selectTask = `
  SELECT
    t.id, t.project_id AS projectId,
    t.asset_id AS assetId,
    a.original_path AS originalPath,
    t.definition_id AS definitionId,
    t.definition_version AS definitionVersion,
    json_extract(v.definition_json, '$.name') AS definitionName,
    v.definition_json AS definitionJson,
    sr.source_record_id AS sourceRecordId,
    sr.question AS sourceQuestion,
    sr.choices_json AS sourceChoicesJson,
    t.created_at AS createdAt
  FROM task_instances AS t
  JOIN audio_assets AS a ON a.id = t.asset_id
  JOIN task_definition_versions AS v
    ON v.definition_id = t.definition_id
   AND v.version = t.definition_version
  LEFT JOIN source_records AS sr ON sr.id = t.source_record_db_id
`;

export const taskInstanceRepository = {
  /** Project existence: differentiates an unknown project from empty results. */
  async projectExists(db: D1Database, id: string): Promise<boolean> {
    return (await db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1")
      .bind(id).first<{ id: string }>()) !== null;
  },

  /** Read a Task Definition's owning project. A draft alone isn't executable. */
  async definitionProject(db: D1Database, definitionId: string) {
    return db.prepare("SELECT project_id AS projectId FROM task_definitions WHERE id = ?")
      .bind(definitionId).first<{ projectId: string }>();
  },

  /** Ensure the specifically requested frozen version exists. */
  async publishedExists(db: D1Database, definitionId: string, version: number) {
    return (await db.prepare(`
      SELECT version FROM task_definition_versions
      WHERE definition_id = ? AND version = ?
    `).bind(definitionId, version).first<{ version: number }>()) !== null;
  },

  /**
   * Assets live in datasets; datasets belong to projects.
   * Looking up the asset's project lets the service prohibit accidental
   * mixing of Project A's recordings with Project B's definitions.
   */
  async assetProject(db: D1Database, assetId: string) {
    return db.prepare(`
      SELECT d.project_id AS projectId
      FROM audio_assets AS a
      JOIN datasets AS d ON d.id = a.dataset_id
      WHERE a.id = ?
    `).bind(assetId).first<{ projectId: string }>();
  },

  /**
   * Optional MMAU question lookup. An external sourceRecordId is unique
   * within its asset, and is resolved to source_records.id for the FK.
   */
  async sourceRow(db: D1Database, assetId: string, sourceRecordId: string) {
    return db.prepare(`
      SELECT id FROM source_records
      WHERE asset_id = ? AND source_record_id = ?
    `).bind(assetId, sourceRecordId).first<{ id: string }>();
  },

  /**
   * INSERT OR IGNORE is only used for the explicit uniqueness collision.
   * Unlike REPLACE, IGNORE won't delete an existing task or overwrite it.
   * A zero-row result becomes HTTP 409 via the service.
   */
  async insert(db: D1Database, input: {
    id: string; projectId: string; definitionId: string;
    definitionVersion: number; assetId: string;
    sourceRecordDbId: string | null; instanceKey: string;
    audioAssetIds?:string[];
  }): Promise<boolean> {
    const statement = db.prepare(`
      INSERT INTO task_instances
        (id, project_id, definition_id, definition_version,
         asset_id, source_record_db_id, instance_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (definition_id, definition_version, asset_id, instance_key)
      DO NOTHING
    `).bind(
      input.id, input.projectId, input.definitionId, input.definitionVersion,
      input.assetId, input.sourceRecordDbId, input.instanceKey,
    );
    if(!input.audioAssetIds){
      const result=await statement.run();
      return result.meta.changes===1;
    }
    // D1 batch executes SQL statements transactionally. Slot inserts can only
    // happen for the newly generated task UUID: if the primary INSERT was a
    // uniqueness collision, WHERE EXISTS prevents orphaned slot rows.
    const slots=input.audioAssetIds.map((assetId,index)=>db.prepare(`
      INSERT INTO task_instance_audio_slots(task_instance_id,slot_index,asset_id)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM task_instances WHERE id=?)`)
      .bind(input.id,index,assetId,input.id));
    const result=await db.batch([statement,...slots]);
    return result[0].meta.changes===1;
  },

  /** One resolved task with audio path and the frozen definition JSON. */
  async find(db: D1Database, id: string): Promise<TaskInstanceRow | null> {
    return db.prepare(`${selectTask} WHERE t.id = ?`)
      .bind(id).first<TaskInstanceRow>();
  },

  /**
   * Project-scoped list. Limit the first iteration to 200 rows so the API
   * doesn't accidentally download thousands of full definition snapshots.
   * The service returns compact summaries; pagination comes later.
   */
  async list(db: D1Database, projectId: string, datasetId?: string) {
    const sql = `
      SELECT t.id, t.project_id AS projectId,
        t.asset_id AS assetId,
        a.original_path AS originalPath,
        t.definition_id AS definitionId,
        t.definition_version AS definitionVersion,
        json_extract(v.definition_json, '$.name') AS definitionName,
        t.created_at AS createdAt
      FROM task_instances AS t
      JOIN audio_assets AS a ON a.id = t.asset_id
      JOIN task_definition_versions AS v
        ON v.definition_id = t.definition_id
       AND v.version = t.definition_version
      WHERE t.project_id = ? ${datasetId ? "AND a.dataset_id = ?" : ""}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 200
    `;
    const stmt = db.prepare(sql);
    const result = datasetId
      ? await stmt.bind(projectId, datasetId).all<{
          id: string; projectId: string; assetId: string; originalPath: string;
          definitionId: string; definitionVersion: number;
          definitionName: string; createdAt: string;
        }>()
      : await stmt.bind(projectId).all<{
          id: string; projectId: string; assetId: string; originalPath: string;
          definitionId: string; definitionVersion: number;
          definitionName: string; createdAt: string;
        }>();
    return result.results;
  },
};
