import type { AllocationItem } from "@/lib/contracts/assignment-allocation";

const itemsSql = `SELECT COALESCE(sr.id,'audio:'||a.id) AS key,a.id AS assetId,
  sr.id AS sourceId,sr.source_record_id AS recordId,a.original_path AS originalPath,sr.question,
  json_extract(sr.canonical_json,'$.sample_id') AS sampleId,
  json_extract(sr.canonical_json,'$.item_id') AS itemId,
  json_extract(sr.canonical_json,'$.source_version') AS sourceVersion
  FROM audio_assets a LEFT JOIN source_records sr ON sr.asset_id=a.id
  JOIN datasets d ON d.id=a.dataset_id WHERE d.project_id=? AND d.id=?`;

/** SQL-only allocation access. No source_labels or annotation answer joins. */
export const allocationRepository = {
  async items(
    db: D1Database,
    project: string,
    dataset: string,
    keys?: string[],
    cursor = "",
  ) {
    const query = keys
      ? `${itemsSql} AND COALESCE(sr.id,'audio:'||a.id) IN (${keys.map(() => "?").join(",")})`
      : `${itemsSql} AND COALESCE(sr.id,'audio:'||a.id)>? ORDER BY key LIMIT 101`;
    return (
      await db
        .prepare(query)
        .bind(project, dataset, ...(keys ?? [cursor]))
        .all<AllocationItem>()
    ).results;
  },
  /** Bounded whole-dataset selection, authorized by project+dataset scope. */
  async allItems(db:D1Database,project:string,dataset:string){
    return (await db.prepare(`${itemsSql} ORDER BY key LIMIT 1001`).bind(project,dataset).all<AllocationItem>()).results;
  },
  async existing(
    db: D1Database,
    project: string,
    definition: string,
    version: number,
    itemKeys: string[],
  ) {
    return (
      await db
        .prepare(
          `SELECT a.id,a.labeller_user_id AS labellerId,i.id AS taskId,
      COALESCE(i.source_record_db_id,'audio:'||i.asset_id) AS itemKey,a.status
      FROM assignments a JOIN task_instances i ON i.id=a.task_instance_id
      WHERE a.project_id=? AND i.definition_id=? AND i.definition_version=?
      AND COALESCE(i.source_record_db_id,'audio:'||i.asset_id) IN (${itemKeys.map(() => "?").join(",")})`,
        )
        .bind(project, definition, version, ...itemKeys)
        .all<{
          id: string;
          labellerId: string;
          taskId: string;
          itemKey: string;
          status: string;
        }>()
    ).results;
  },
  async workloads(db: D1Database, project: string) {
    return (
      await db
        .prepare(
          `SELECT labeller_user_id AS userId,COUNT(*) AS count FROM assignments
      WHERE project_id=? AND status IN ('assigned','in_progress') GROUP BY labeller_user_id`,
        )
        .bind(project)
        .all<{ userId: string; count: number }>()
    ).results;
  },
  /** Existing UNIQUE(task_instance_id,labeller_user_id) makes retries safe. All
   * assignment inserts share one D1 transaction; no historical row is replaced.
   * Task Instances are reusable prerequisites and may survive a failed batch.
   */
  async insert(
    db: D1Database,
    project: string,
    pairs: Array<{ taskId: string; labellerId: string }>,
  ) {
    const statements = [];
    for (let offset = 0; offset < pairs.length; offset += 20) {
      const chunk = pairs.slice(offset, offset + 20);
      statements.push(
        db
          .prepare(
            `INSERT INTO assignments(id,project_id,task_instance_id,labeller_user_id)
        VALUES ${chunk.map(() => "(?,?,?,?)").join(",")}
        ON CONFLICT(task_instance_id,labeller_user_id) DO NOTHING`,
          )
          .bind(
            ...chunk.flatMap((pair) => [
              crypto.randomUUID(),
              project,
              pair.taskId,
              pair.labellerId,
            ]),
          ),
      );
    }
    const results = await db.batch(statements);
    return results.reduce((total, result) => total + result.meta.changes, 0);
  },
};
