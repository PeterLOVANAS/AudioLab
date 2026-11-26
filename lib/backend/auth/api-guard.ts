import {
  authenticate,
  AuthError,
  projectRole,
  requireSameOrigin,
  type AuthSettings,
} from "./identity";
import { boundedBody } from "@/lib/backend/http/request-body";

// New APIs require an explicit policy entry; supplying projectId is never enough
// to turn an unknown/legacy utility into an authorized production operation.
const routes: [RegExp, string[]][] = [
  [/^\/api\/v1\/projects$/, ["GET", "POST"]],
  [
    /^\/api\/v1\/(datasets|assets|task-definitions|task-instances|assignments|project-members|worker-profiles|team-jobs|assignment-allocation)$/,
    ["GET", "POST"],
  ],
  [/^\/api\/v1\/assets\/[^/]+\/audio$/, ["GET", "HEAD"]],
  [/^\/api\/v1\/assets\/[^/]+\/metadata$/, ["POST"]],
  [/^\/api\/v1\/(source-records|annotation-candidates)$/, ["GET", "POST"]],
  [/^\/api\/v1\/(source-fields|research-export|research-overview)$/, ["GET"]],
  [/^\/api\/v1\/dataset-ingestion\/(validate|import)$/, ["POST"]],
  [/^\/api\/v1\/dataset-ingestion\/inspect$/, ["GET"]],
  [/^\/api\/v1\/task-definitions\/[^/]+$/, ["GET", "PUT"]],
  [/^\/api\/v1\/task-definitions\/[^/]+\/publish$/, ["POST"]],
  [/^\/api\/v1\/task-definitions\/[^/]+\/versions\/[^/]+$/, ["GET"]],
  [/^\/api\/v1\/task-instances\/[^/]+$/, ["GET"]],
  [/^\/api\/v1\/assignments\/[^/]+$/, ["GET"]],
  [
    /^\/api\/v1\/assignments\/[^/]+\/(annotation|annotation\/revisions|candidates)$/,
    ["GET"],
  ],
  [
    /^\/api\/v1\/assignments\/[^/]+\/(start|annotation\/draft|annotation\/submit)$/,
    ["POST"],
  ],
  [
    /^\/api\/v1\/labeller\/(assigned-queue|overview|queue|queue\/page)$/,
    ["GET"],
  ],
  [/^\/api\/v1\/labeller\/audio-queue$/, ["GET", "POST"]],
  [/^\/api\/v1\/candidate-sets$/, ["POST"]],
  [/^\/api\/v1\/candidate-sets\/sources$/, ["GET"]],
  [/^\/api\/v1\/candidate-sets\/[^/]+\/result$/, ["GET", "POST"]],
];

/** Central fail-closed resource authorization. Every /api request passes this
 * middleware; legacy fixture IDs are checked against the verified account rather
 * than treated as identity. Unknown/resource-less APIs are denied by default.
 */
export async function authorizeApi(
  db: D1Database,
  request: Request,
  settings: AuthSettings,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname.replace(/\/+$/, ""),
    method = request.method;
  if (/^\/api\/v1\/auth\/(session|login|logout)$/.test(path)) return null;
  try {
    const user = await authenticate(db, request, settings);
    if (
      !routes.some(
        ([pattern, methods]) => pattern.test(path) && methods.includes(method),
      )
    )
      throw new AuthError(403, "Unsupported API operation.");
    if (!["GET", "HEAD"].includes(method)) requireSameOrigin(request, settings);
    let body: Record<string, unknown> = {};
    if (
      request.headers.get("content-type")?.includes("application/json") &&
      !["GET", "HEAD"].includes(method)
    ) {
      const raw = new TextDecoder().decode(
        await boundedBody(request, 512 * 1024),
      );
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          body = parsed;
      } catch {
        throw new AuthError(400, "Invalid JSON.");
      }
    } else if (
      !["GET", "HEAD"].includes(method) &&
      !request.headers.get("content-type")?.includes("multipart/form-data")
    ) {
      // Do not let changing Content-Type bypass the route's JSON size budget.
      await boundedBody(request, 512 * 1024);
    }
    const q = url.searchParams;
    if (
      path.startsWith("/api/v1/candidate-sets") &&
      (q.get("userId") ?? body.userId) !== user.userId
    )
      throw new AuthError(403, "Candidate actor must match login.");
    if (
      path.startsWith("/api/v1/labeller/") &&
      q.get("labellerId") !== user.userId
    )
      throw new AuthError(403, "Cannot impersonate another labeller.");
    if (
      path.includes("/annotation") &&
      body.labellerId !== undefined &&
      body.labellerId !== user.userId
    )
      throw new AuthError(403, "Cannot submit as another worker.");
    if (
      ["/api/v1/source-fields"].includes(path) &&
      q.get("userId") !== user.userId
    )
      throw new AuthError(403, "Source viewer must be the authenticated user.");
    if (
      path.startsWith("/api/v1/dataset-ingestion") &&
      q.get("userId") !== user.userId
    )
      throw new AuthError(403, "Import actor must match login.");
    if (
      path === "/api/v1/assignment-allocation" &&
      (q.get("adminId") ?? body.adminId) !== user.userId
    )
      throw new AuthError(403, "Allocation actor must match login.");
    const memberships = (
      await db
        .prepare(
          `SELECT m.project_id AS projectId,m.user_id AS userId,m.display_name AS displayName,m.role,p.name,p.slug
  FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.user_id=?`,
        )
        .bind(user.userId)
        .all<{
          projectId: string;
          userId: string;
          displayName: string;
          role: string;
          name: string;
          slug: string;
        }>()
    ).results;
    if (path === "/api/v1/projects") {
      if (method === "GET")
        return Response.json({
          projects: memberships.map((m) => ({
            id: m.projectId,
            name: m.name,
            slug: m.slug,
          })),
        });
      if (
        method === "POST" &&
        memberships.some((member) => member.role === "admin")
      )
        return null;
      throw new AuthError(
        403,
        "Existing project admin permission is required to create a project.",
      );
    }
    let project =
      typeof body.projectId === "string" ? body.projectId : q.get("projectId");
    if (
      typeof body.projectId === "string" &&
      q.has("projectId") &&
      q.get("projectId") !== body.projectId
    )
      throw new AuthError(403, "Conflicting project scope.");
    async function bindScope(actual: string | null | undefined) {
      if (!actual) throw new AuthError(404, "Resource not found.");
      if (project && project !== actual)
        throw new AuthError(403, "Resource belongs to another project.");
      project = actual;
    }
    const assignmentId = path.match(/^\/api\/v1\/assignments\/([^/]+)/)?.[1];
    let assignmentOwner: string | undefined;
    if (assignmentId) {
      const a = await db
        .prepare(
          "SELECT project_id AS projectId,labeller_user_id AS owner FROM assignments WHERE id=?",
        )
        .bind(assignmentId)
        .first<{ projectId: string; owner: string }>();
      if (!a) throw new AuthError(404, "Assignment not found.");
      await bindScope(a.projectId);
      assignmentOwner = a.owner;
    }
    const taskId =
      path.match(/^\/api\/v1\/task-instances\/([^/]+)/)?.[1] ??
      (typeof body.taskInstanceId === "string"
        ? body.taskInstanceId
        : q.get("taskInstanceId"));
    if (taskId) {
      const t = await db
        .prepare(
          "SELECT project_id AS projectId FROM task_instances WHERE id=?",
        )
        .bind(taskId)
        .first<{ projectId: string }>();
      if (!t) throw new AuthError(404, "Task not found.");
      await bindScope(t.projectId);
    }
    const definitionId =
      path.match(/^\/api\/v1\/task-definitions\/([^/]+)/)?.[1] ??
      (typeof body.definitionId === "string"
        ? body.definitionId
        : q.get("definitionId"));
    if (definitionId) {
      await bindScope(
        (
          await db
            .prepare("SELECT project_id AS p FROM task_definitions WHERE id=?")
            .bind(definitionId)
            .first<{ p: string }>()
        )?.p,
      );
    }
    const assetId =
      path.match(/^\/api\/v1\/assets\/([^/]+)/)?.[1] ??
      (typeof body.assetId === "string" ? body.assetId : q.get("assetId"));
    const datasetId =
      typeof body.datasetId === "string" ? body.datasetId : q.get("datasetId");
    if (assetId)
      await bindScope(
        (
          await db
            .prepare(
              "SELECT d.project_id AS p FROM audio_assets a JOIN datasets d ON d.id=a.dataset_id WHERE a.id=?",
            )
            .bind(assetId)
            .first<{ p: string }>()
        )?.p,
      );
    if (datasetId)
      await bindScope(
        (
          await db
            .prepare("SELECT project_id AS p FROM datasets WHERE id=?")
            .bind(datasetId)
            .first<{ p: string }>()
        )?.p,
      );
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const bytes = await boundedBody(request, 11 * 1024 * 1024);
      const form = await new Response(bytes, {
          headers: { "content-type": request.headers.get("content-type")! },
        }).formData(),
        id = form.get("datasetId");
      if (typeof id !== "string") throw new AuthError(400, "Dataset required.");
      await bindScope(
        (
          await db
            .prepare("SELECT project_id AS p FROM datasets WHERE id=?")
            .bind(id)
            .first<{ p: string }>()
        )?.p,
      );
    }
    const jobId =
      q.get("jobId") ??
      (typeof body.jobId === "string" ? body.jobId : undefined);
    // A new job ID has no row before launch; POST carries a validated project scope.
    if (jobId && (method === "GET" || q.get("action") === "delete"))
      await bindScope(
        (
          await db
            .prepare("SELECT project_id AS p FROM annotation_jobs WHERE id=?")
            .bind(jobId)
            .first<{ p: string }>()
        )?.p,
      );
    if (!project) throw new AuthError(403, "Resource/project scope required.");
    const member = memberships.find((m) => m.projectId === project);
    if (!member) throw new AuthError(403, "Not a member of this project.");
    if (path === "/api/v1/project-members" && method === "GET") {
      if (member.role !== "admin")
        return Response.json({
          members: [
            {
              projectId: project,
              userId: user.userId,
              displayName: member.displayName,
              role: member.role,
            },
          ],
        });
      return Response.json({
        members: (
          await db
            .prepare(
              "SELECT project_id AS projectId,user_id AS userId,display_name AS displayName,role,created_at AS createdAt FROM project_members WHERE project_id=? ORDER BY display_name",
            )
            .bind(project)
            .all()
        ).results,
      });
    }
    if (assignmentId) {
      if (
        !["GET", "HEAD"].includes(method) &&
        (await db
          .prepare(
            "SELECT 1 FROM annotation_job_assignments ja JOIN annotation_jobs j ON j.id=ja.job_id WHERE ja.assignment_id=? AND j.deleted_at IS NOT NULL",
          )
          .bind(assignmentId)
          .first())
      )
        throw new AuthError(
          410,
          "This job was deleted. Assignment history is read-only.",
        );
      const ownerOnly =
        path.includes("/annotation") ||
        path.endsWith("/start") ||
        path.endsWith("/candidates");
      if (
        assignmentOwner !== user.userId &&
        (ownerOnly || member.role !== "admin")
      )
        throw new AuthError(403, "Assignment belongs to another worker.");
      if (body.labellerId !== undefined && body.labellerId !== user.userId)
        throw new AuthError(403, "Actor mismatch.");
      return null;
    }
    if (member.role === "admin") return null;
    if (method !== "GET" && method !== "HEAD")
      throw new AuthError(403, "Project admin permission required.");
    if (path.startsWith("/api/v1/labeller/") && !path.includes("audio-queue"))
      return null;
    if (path === "/api/v1/datasets") return null;
    // The existing workspace loads this compact name/domain/version catalog.
    // repo.list selects no blocks, bindings, source metadata or reference values;
    // definition drafts/versions remain admin-only outside assigned task previews.
    if (path === "/api/v1/task-definitions") return null;
    if (assetId && path.endsWith("/audio")) {
      const own = await db
        .prepare(
          `SELECT 1 FROM assignments a JOIN task_instances i ON i.id=a.task_instance_id
   WHERE a.project_id=? AND a.labeller_user_id=? AND (i.asset_id=? OR EXISTS(SELECT 1 FROM task_instance_audio_slots s WHERE s.task_instance_id=i.id AND s.asset_id=?)) LIMIT 1`,
        )
        .bind(project, user.userId, assetId, assetId)
        .first();
      if (own) return null;
    }
    if (
      taskId &&
      (await db
        .prepare(
          "SELECT 1 FROM assignments WHERE task_instance_id=? AND labeller_user_id=? AND project_id=? LIMIT 1",
        )
        .bind(taskId, user.userId, project)
        .first())
    )
      return null;
    throw new AuthError(403, "Admin-only resource.");
  } catch (error) {
    if (error instanceof AuthError)
      return Response.json(
        { error: error.message },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    console.error("Authorization unavailable");
    return Response.json(
      {
        error:
          "Authentication/authorization unavailable. Check identity schema and configuration.",
      },
      { status: 503 },
    );
  }
}
