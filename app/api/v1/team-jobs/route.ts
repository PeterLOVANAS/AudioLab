import { requiredTaskRecordings } from "@/lib/contracts/task-batches";
import { env } from "cloudflare:workers";
import { BindingResolutionError } from "@/lib/frontend/source-binding";
import { TaskDefinitionNotFoundError } from "@/lib/backend/services/task-definitions";
import {
  authenticate,
  AuthError,
  requireProjectAdmin,
  type AuthSettings,
} from "@/lib/backend/auth/identity";
import {
  workerProfiles,
  teams,
  buildJobPlan,
  launchJob,
  jobSummaries,
  jobDetail,
  deleteJob,
} from "@/lib/backend/services/team-jobs";
import { jobResults } from "@/lib/backend/services/job-results";
import { jobInputSchema } from "@/lib/backend/validation/team-jobs";
import { allocationRepository } from "@/lib/backend/repositories/assignment-allocation";
import { assignmentService } from "@/lib/backend/services/assignments";
/** Team-job board, frozen allocation previews and admin-only progress/results. */
export async function GET(request: Request) {
  try {
    const user = await authenticate(
        env.DB,
        request,
        env as unknown as AuthSettings,
      ),
      q = new URL(request.url).searchParams;
    const project = q.get("projectId") ?? "";
    await requireProjectAdmin(env.DB, project, user.userId);
    const action = q.get("action");
    if (action === "catalog") {
      const definitions=(await env.DB.prepare("SELECT id,json_extract(draft_json,'$.name') AS name,published_version AS publishedVersion FROM task_definitions WHERE project_id=? AND published_version>0 ORDER BY name").bind(project).all<{id:string;name:string;publishedVersion:number}>()).results;
      const versions=(await env.DB.prepare("SELECT v.definition_id AS id,v.version,v.definition_json AS json FROM task_definition_versions v JOIN task_definitions d ON d.id=v.definition_id WHERE d.project_id=?").bind(project).all<{id:string;version:number;json:string}>()).results;
      return Response.json({
        workers: await workerProfiles(env.DB, project),
        teams: await teams(env.DB, project),
        datasets: (
          await env.DB.prepare(
            "SELECT d.id,d.name,d.version,(SELECT COUNT(*) FROM audio_assets a LEFT JOIN source_records s ON s.asset_id=a.id WHERE a.dataset_id=d.id) AS itemCount FROM datasets d WHERE d.project_id=? ORDER BY d.name",
          )
            .bind(project)
            .all()
        ).results,
        definitions:definitions.map(definition=>({...definition,versions:versions.filter(version=>version.id===definition.id).map(version=>({version:version.version,recordingsPerTask:requiredTaskRecordings(JSON.parse(version.json).blocks)}))})),
      });
    }
    if (action === "items") {
      const dataset = q.get("datasetId") ?? "";
      if (
        !(await env.DB.prepare(
          "SELECT id FROM datasets WHERE id=? AND project_id=?",
        )
          .bind(dataset, project)
          .first())
      )
        throw new AuthError(404, "Dataset not in this project.");
      const rows = await allocationRepository.items(
        env.DB,
        project,
        dataset,
        undefined,
        q.get("cursor") ?? "",
      );
      return Response.json({
        items: rows.slice(0, 100),
        nextCursor: rows.length > 100 ? rows[99].key : null,
      });
    }
    if (["detail", "results", "task"].includes(action ?? "")) {
      const detail = await jobDetail(env.DB, user.userId, q.get("jobId") ?? "");
      if (detail.summary.projectId !== project)
        throw new AuthError(403, "Cross-project job.");
      if (action === "results")
        return Response.json(
          await jobResults(env.DB, user.userId, detail.summary.id),
        );
      if (action === "task") {
        const assignment = detail.assignments.find(
          (a) => a.id === q.get("assignmentId"),
        );
        if (!assignment)
          throw new AuthError(404, "Task does not belong to this job.");
        return Response.json({
          ...(await assignmentService.detail(env.DB, assignment.id)),
          current: assignment,
        });
      }
      return Response.json(detail);
    }
    return Response.json({ jobs: await jobSummaries(env.DB, project,undefined,q.get("includeArchived")==="1") });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const user = await authenticate(
        env.DB,
        request,
        env as unknown as AuthSettings,
      ),
      action = new URL(request.url).searchParams.get("action");
    const body = (await request.json()) as Record<string, unknown>;
    if(action==="delete"){
      if(typeof body.projectId!=="string"||typeof body.jobId!=="string")throw new AuthError(400,"Project and job IDs are required.");
      return Response.json(await deleteJob(env.DB,user.userId,body.projectId,body.jobId));
    }
    if (action === "preview")
      return Response.json({
        plan: await buildJobPlan(
          env.DB,
          user.userId,
          jobInputSchema.parse(body),
        ),
      });
    if (action === "launch") {
      const { expectedHash, ...input } = body;
      if (typeof expectedHash !== "string")
        throw new AuthError(400, "Preview hash required.");
      return Response.json(
        await launchJob(
          env.DB,
          user.userId,
          jobInputSchema.parse(input),
          expectedHash,
        ),
      );
    }
    throw new AuthError(400, "Choose preview or launch.");
  } catch (error) {
    return failure(error);
  }
}
function failure(error: unknown) {
  if (error instanceof AuthError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof TaskDefinitionNotFoundError)
    return Response.json({ error: error.message }, { status: 404 });
  if (error instanceof BindingResolutionError)
    return Response.json({ error: error.message }, { status: 422 });
  if (error && typeof error === "object" && "issues" in error)
    return Response.json(
      { error: "Invalid job configuration", issues: error.issues },
      { status: 400 },
    );
  // Unexpected exceptions can contain fragments of persisted source JSON. Keep
  // them out of API responses and logs; known permission/validation errors above
  // retain their actionable, intentionally authored messages.
  console.error("Team job failed unexpectedly");
  return Response.json(
    {
      error: "Team job operation failed. Check configuration and schema; no success is assumed.",
    },
    { status: 500 },
  );
}
