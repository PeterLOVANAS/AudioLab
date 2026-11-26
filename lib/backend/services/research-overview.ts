import { requireProjectAdmin } from "@/lib/backend/auth/identity";
import type {
  ResearchOverview,
  ResearchProjectStats,
} from "@/lib/contracts/research-overview";

/** One scoped aggregate, no per-project queries or answer/reference reads.
 * Batch assignments link their first source item; expand immutable batch members
 * before deduplicating project/source identity. Repeated campaigns do not inflate
 * unique-item counts. An item is complete only when all its active assignments
 * are submitted/reviewed. Deleted jobs are excluded, including legacy queues.
 */
export async function researchOverview(
  db: D1Database,
  actor: string,
  contextProject: string,
): Promise<ResearchOverview> {
  await requireProjectAdmin(db, contextProject, actor);
  const rows = (
    await db
      .prepare(
        `WITH permitted AS (
    SELECT p.id,p.name,p.slug FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=? AND m.role='admin'
  ), active_jobs AS (
    SELECT j.* FROM annotation_jobs j JOIN permitted p ON p.id=j.project_id WHERE j.deleted_at IS NULL
  ), active_assignments AS (
    SELECT a.* FROM assignments a JOIN permitted p ON p.id=a.project_id
    WHERE NOT EXISTS(SELECT 1 FROM annotation_job_assignments ja JOIN annotation_jobs j ON j.id=ja.job_id WHERE ja.assignment_id=a.id AND j.deleted_at IS NOT NULL)
  ), coverage AS (
    SELECT j.project_id,item.item_key,a.id AS assignment_id,a.status
    FROM active_jobs j JOIN annotation_job_items item ON item.job_id=j.id
    JOIN annotation_job_assignments ja ON ja.job_id=j.id AND ja.item_key=COALESCE(
      (SELECT json_extract(batch.value,'$.itemKeys[0]') FROM json_each(j.plan_json,'$.batches') batch
       WHERE EXISTS(SELECT 1 FROM json_each(batch.value,'$.itemKeys') member WHERE member.value=item.item_key) LIMIT 1),item.item_key)
    JOIN active_assignments a ON a.id=ja.assignment_id WHERE j.launched_at IS NOT NULL
    UNION ALL
    SELECT a.project_id,COALESCE(json_extract(i.input_snapshot_json,'$.batch['||COALESCE(s.slot_index,0)||'].source.sourceRecordId'),
      CASE WHEN COALESCE(s.slot_index,0)=0 THEN i.source_record_db_id END,'audio:'||COALESCE(s.asset_id,i.asset_id)),a.id,a.status
    FROM active_assignments a JOIN task_instances i ON i.id=a.task_instance_id
    LEFT JOIN task_instance_audio_slots s ON s.task_instance_id=i.id
    WHERE NOT EXISTS(SELECT 1 FROM annotation_job_assignments ja WHERE ja.assignment_id=a.id)
  ), item_progress AS (
    SELECT project_id,item_key,MIN(CASE WHEN status IN ('submitted','reviewed') THEN 1 ELSE 0 END) AS complete
    FROM coverage GROUP BY project_id,item_key
  ), item_totals AS (
    SELECT project_id,COUNT(*) AS total,SUM(complete) AS complete FROM item_progress GROUP BY project_id
  ), assignment_totals AS (
    SELECT project_id,COUNT(*) AS total,SUM(status IN ('submitted','reviewed')) AS submitted,
      SUM(status='in_progress') AS in_progress,SUM(status='assigned') AS pending,MAX(submitted_at) AS last_submitted
    FROM active_assignments GROUP BY project_id
  ), job_totals AS (
    SELECT j.project_id,COUNT(*) AS total,SUM(j.launched_at IS NOT NULL AND json_array_length(j.plan_json,'$.pairs')>0 AND
      (SELECT COUNT(*) FROM annotation_job_assignments ja JOIN active_assignments a ON a.id=ja.assignment_id WHERE ja.job_id=j.id AND a.status IN ('submitted','reviewed'))=json_array_length(j.plan_json,'$.pairs')) AS complete
    FROM active_jobs j GROUP BY j.project_id
  ), dataset_totals AS (SELECT d.project_id,COUNT(*) AS total FROM datasets d JOIN permitted p ON p.id=d.project_id GROUP BY d.project_id),
  audio_totals AS (SELECT d.project_id,COUNT(*) AS total FROM audio_assets a JOIN datasets d ON d.id=a.dataset_id JOIN permitted p ON p.id=d.project_id GROUP BY d.project_id),
  definition_totals AS (SELECT d.project_id,COUNT(*) AS total FROM task_definitions d JOIN permitted p ON p.id=d.project_id GROUP BY d.project_id),
  worker_totals AS (SELECT m.project_id,COUNT(*) AS total FROM project_members m JOIN permitted p ON p.id=m.project_id WHERE m.role='labeller' GROUP BY m.project_id)
  SELECT p.id,p.name,p.slug,COALESCE(d.total,0) AS datasets,COALESCE(audio.total,0) AS audioFiles,
    COALESCE(defs.total,0) AS definitions,COALESCE(w.total,0) AS labellers,COALESCE(j.total,0) AS jobs,COALESCE(j.complete,0) AS completedJobs,
    COALESCE(a.total,0) AS assignments,COALESCE(a.submitted,0) AS submitted,COALESCE(a.in_progress,0) AS inProgress,COALESCE(a.pending,0) AS pending,
    COALESCE(items.total,0) AS sourceItems,COALESCE(items.complete,0) AS completedSourceItems,a.last_submitted AS lastSubmittedAt
  FROM permitted p LEFT JOIN dataset_totals d ON d.project_id=p.id LEFT JOIN audio_totals audio ON audio.project_id=p.id
    LEFT JOIN definition_totals defs ON defs.project_id=p.id LEFT JOIN worker_totals w ON w.project_id=p.id
    LEFT JOIN job_totals j ON j.project_id=p.id LEFT JOIN assignment_totals a ON a.project_id=p.id LEFT JOIN item_totals items ON items.project_id=p.id
  ORDER BY p.name,p.id`,
      )
      .bind(actor)
      .all<Omit<ResearchProjectStats, "status">>()
  ).results;
  const projects = rows.map((row) => ({
    ...row,
    status:
      row.assignments === 0
        ? ("setup" as const)
        : row.submitted === row.assignments
          ? ("complete" as const)
          : ("active" as const),
  }));
  const sum = (
    key:
      | "datasets"
      | "audioFiles"
      | "jobs"
      | "assignments"
      | "submitted"
      | "sourceItems"
      | "completedSourceItems",
  ) => projects.reduce((total, project) => total + project[key], 0);
  return {
    asOf: new Date().toISOString(),
    scope: "admin-projects",
    projects,
    totals: {
      projects: projects.length,
      datasets: sum("datasets"),
      audioFiles: sum("audioFiles"),
      jobs: sum("jobs"),
      assignments: sum("assignments"),
      submitted: sum("submitted"),
      sourceItems: sum("sourceItems"),
      completedSourceItems: sum("completedSourceItems"),
    },
  };
}
