import { env } from "cloudflare:workers";
import { z } from "zod";
import { assignmentRepository } from "@/lib/backend/repositories/assignments";

/** Owner-scoped real assignments across published versions. No answer joins,
 * task creation or peer responses. Submitted jobs remain available for reopening.
 * The mandatory proxy verifies identity; job filters never grant access to peers.
 */
export async function GET(request: Request) {
  // Mandatory middleware verifies the logged-in owner, including in production.
  const parsed = z
    .strictObject({
      projectId: z.uuid(),
      labellerId: z.string().min(1).max(128),
      queueJobId: z.union([z.uuid(),z.literal("standalone")]).optional(),
      cursor: z.string().max(1000).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    .safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success)
    return Response.json(
      { error: "Invalid assigned queue parameters" },
      { status: 400 },
    );
  const { projectId, labellerId, cursor, limit, queueJobId } = parsed.data;
  try {
    if (
      (await assignmentRepository.member(env.DB, projectId, labellerId))
        ?.role !== "labeller"
    )
      return Response.json(
        { error: "Not an eligible project labeller" },
        { status: 403 },
      );
    const rows = (
      await env.DB.prepare(
        `SELECT a.id,a.status,i.id AS taskId,i.asset_id AS assetId,
      audio.original_path AS originalPath,audio.duration_seconds AS durationSeconds,
      i.definition_version AS version,json_extract(v.definition_json,'$.name') AS name,
      sr.source_record_id AS sourceRecordId,sr.question,job.id AS jobId,job.name AS jobName
      FROM assignments a JOIN task_instances i ON i.id=a.task_instance_id
      JOIN audio_assets audio ON audio.id=i.asset_id
      JOIN task_definition_versions v ON v.definition_id=i.definition_id AND v.version=i.definition_version
      LEFT JOIN source_records sr ON sr.id=i.source_record_db_id
      LEFT JOIN annotation_job_assignments ja ON ja.assignment_id=a.id
      LEFT JOIN annotation_jobs job ON job.id=ja.job_id
      WHERE a.project_id=? AND a.labeller_user_id=? AND job.deleted_at IS NULL AND (? IS NULL OR job.id=? OR (?='standalone' AND job.id IS NULL)) AND (? IS NULL OR a.id>?)
      ORDER BY a.id LIMIT ?`,
      )
        .bind(projectId, labellerId, queueJobId ?? null, queueJobId ?? null, queueJobId ?? null, cursor ?? null, cursor ?? null, limit + 1)
        .all<{
          id: string;
          status: string;
          taskId: string;
          assetId: string;
          originalPath: string;
          durationSeconds: number | null;
          version: number;
          name: string;
          sourceRecordId: string | null;
          question: string | null;
          jobId: string | null;
          jobName: string | null;
        }>()
    ).results;
    const page = rows.slice(0, limit);
    const slots = page.length
      ? (
          await env.DB.prepare(
            `SELECT s.task_instance_id AS taskId,a.id,a.original_path AS originalPath,a.duration_seconds AS durationSeconds
      FROM task_instance_audio_slots s JOIN audio_assets a ON a.id=s.asset_id
      WHERE s.task_instance_id IN (${page.map(() => "?").join(",")}) ORDER BY s.task_instance_id,s.slot_index`,
          )
            .bind(...page.map((row) => row.taskId))
            .all<{
              taskId: string;
              id: string;
              originalPath: string;
              durationSeconds: number | null;
            }>()
        ).results
      : [];
    const counts = await env.DB.prepare(
      `SELECT COUNT(*) AS total,COUNT(DISTINCT i.asset_id) AS audio,
      COALESCE(SUM(a.status IN ('submitted','reviewed')),0) AS complete,
      COALESCE(SUM(a.status IN ('assigned','in_progress')),0) AS pending
      FROM assignments a JOIN task_instances i ON i.id=a.task_instance_id
      LEFT JOIN annotation_job_assignments ja ON ja.assignment_id=a.id LEFT JOIN annotation_jobs job ON job.id=ja.job_id
      WHERE a.project_id=? AND a.labeller_user_id=? AND job.deleted_at IS NULL AND (? IS NULL OR ja.job_id=? OR (?='standalone' AND ja.job_id IS NULL))`,
    )
      .bind(projectId, labellerId,queueJobId ?? null,queueJobId ?? null,queueJobId ?? null)
      .first<{
        total: number;
        audio: number;
        complete: number;
        pending: number;
      }>();
    // List every owned job, not only the first loaded page, so switching jobs
    // cannot hide assignments behind another job's pagination window.
    const jobs = (await env.DB.prepare(`SELECT COALESCE(j.id,'standalone') AS id,COALESCE(j.name,'Other assigned tasks') AS name,COUNT(*) AS total
      FROM assignments a LEFT JOIN annotation_job_assignments ja ON ja.assignment_id=a.id
      LEFT JOIN annotation_jobs j ON j.id=ja.job_id WHERE a.project_id=? AND a.labeller_user_id=? AND j.deleted_at IS NULL
      GROUP BY j.id,j.name ORDER BY name`).bind(projectId,labellerId).all<{id:string;name:string;total:number}>()).results;
    return Response.json({
      jobs,
      definition: { id: "assigned", version: 1, name: "Your assigned tasks" },
      requiredAudio: 1,
      totalAudio: counts?.audio ?? 0,
      totalCompleteGroups: counts?.total ?? 0,
      totalSubmitted: counts?.complete ?? 0,
      totalPending: counts?.pending ?? 0,
      remainderAudio: 0,
      groups: page.map((row) => ({
        key: row.id,
        assignmentId: row.id,
        status: row.status,
        sourceRecordId: row.sourceRecordId,
        jobId: row.jobId,
        jobName: row.jobName,
        title: `${row.jobName ? row.jobName + " · " : ""}${row.name} · v${row.version}${row.question ? ` · ${row.question}` : ""}`,
        assets: slots.some((slot) => slot.taskId === row.taskId)
          ? slots
              .filter((slot) => slot.taskId === row.taskId)
              .map(({ taskId, ...asset }) => asset)
          : [
              {
                id: row.assetId,
                originalPath: row.originalPath,
                durationSeconds: row.durationSeconds,
              },
            ],
      })),
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? page.at(-1)?.id : null,
    });
  } catch (error) {
    console.error("Assigned queue failed", error);
    return Response.json(
      { error: "Cannot load assigned work. Check local schema/server logs." },
      { status: 500 },
    );
  }
}
