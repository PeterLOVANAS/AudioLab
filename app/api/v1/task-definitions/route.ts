import { TaskDefinitionPublicationError } from "@/lib/backend/services/task-definitions";
/**
 * ROUTE: /api/v1/task-definitions
 * -------------------------------
 * GET  -> List definitions associated with one project.
 * POST -> Create a new editable definition within a project.
 *
 * File-based routing: Vinext/Next App Router maps THIS `route.ts` file to
 * /api/v1/task-definitions automatically; exported function names correspond
 * to HTTP methods. No Express `app.get()` setup is needed.
 *
 * A ROUTE should do four things:
 * 1) Require the mandatory authenticated project-admin API boundary.
 * 2) Parse and validate the incoming HTTP request.
 * 3) Call the reusable service for business operations.
 * 4) Map the service result or error to an appropriate HTTP response.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { createTaskDefinitionSchema } from "@/lib/backend/validation/task-definitions";
import {
  taskDefinitionService as service,
  ProjectNotFoundError,
} from "@/lib/backend/services/task-definitions";

/**
 * `GET /api/v1/task-definitions?projectId=<uuid>`
 *
 * Query parameters are in the URL, not in a JSON request body.
 * Example success: HTTP 200 { definitions: [...] }
 * Example unknown project: HTTP 404 { error: "Project not found." }
 */
export async function GET(request: Request) {
  // Authenticated project/resource access is enforced by proxy.ts.


  // `new URL` parses both the path and ?projectId=... query parameter.
  const projectId = new URL(request.url).searchParams.get("projectId");

  // A UUID can be syntactically valid but absent from D1 (which becomes 404).
  if (!z.uuid().safeParse(projectId).success) {
    return Response.json(
      { error: "Valid projectId required." },
      { status: 400 },
    );
  }

  try {
    // env.DB is the Cloudflare D1 binding generated from cloudflare.config.ts.
    // The ! tells TypeScript it isn't null after the validation above.
    const definitions = await service.list(env.DB, projectId!);
    return Response.json({ definitions }); // Default HTTP status is 200.
  } catch (error) {
    // Domain-specific errors are predictable; don't report them as 500.
    if (error instanceof ProjectNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }

    // Log internal failure on server only; don't reveal private SQL errors.
    console.error("GET task definitions failed", error);
    return Response.json(
      { error: "Unable to list task definitions." },
      { status: 500 },
    );
  }
}

/**
 * `POST /api/v1/task-definitions`
 *
 * Body: { projectId: UUID, draft: { name, blocks, policy, ... } }
 * A successful create returns HTTP 201 and the newly saved draft, including
 * its generated ID, draftRevision=1 and publishedVersion=0.
 */
export async function POST(request: Request) {
  // Authenticated project/resource access is enforced by proxy.ts.


  // `unknown` is intentional: never assume received JSON matches our types.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body." }, { status: 400 });
  }

  // `.safeParse()` returns {success:false,error} instead of throwing.
  // The error.issues array includes paths that your future Task Builder can
  // use to display validation errors beside the matching form inputs.
  const parsed = createTaskDefinitionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid task definition.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const taskDefinition = await service.create(
      env.DB,
      parsed.data.projectId,
      parsed.data.draft,
    );
    return Response.json({ taskDefinition }, { status: 201 });
  } catch (error) {
    if (error instanceof TaskDefinitionPublicationError) return Response.json({error:error.message},{status:422});
    if (error instanceof ProjectNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }

    console.error("POST task definitions failed", error);
    return Response.json(
      { error: "Unable to create task definition." },
      { status: 500 },
    );
  }
}
