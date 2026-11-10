/**
 * ROUTE: /api/v1/task-definitions/[id]
 * ------------------------------------
 * GET -> Read the current editable draft and its revision/version counters.
 * PUT -> Replace that draft IF the caller's expectedRevision is still current.
 *
 * `[id]` is a dynamic URL segment. A URL ending in /550e... yields
 * context.params.id = "550e...". One handler serves every definition ID.
 *
 * Notice: PUT replaces the FULL draft; it isn't a partial PATCH request.
 * A teammate should load the latest draft, edit it, then send all fields.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { updateTaskDefinitionSchema } from "@/lib/backend/validation/task-definitions";
import {
  taskDefinitionService as service,
  TaskDefinitionNotFoundError,
  TaskDefinitionConflictError,
} from "@/lib/backend/services/task-definitions";

// Vinext's App Router supplies async dynamic URL params in `context`.
// The Promise shape is why handlers use `await context.params`.
type Ctx = { params: Promise<{ id: string }> };

/** `GET /api/v1/task-definitions/{id}` -> latest editable version. */
export async function GET(_request: Request, context: Ctx) {
  // `_request` starts with an underscore because this GET doesn't use it.
  if (!import.meta.env.DEV) {
    return Response.json(
      { error: "Authentication not configured." },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) {
    return Response.json(
      { error: "Invalid task definition ID." },
      { status: 400 },
    );
  }

  try {
    const taskDefinition = await service.get(env.DB, id);
    return Response.json({ taskDefinition });
  } catch (error) {
    if (error instanceof TaskDefinitionNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("GET task definition failed", error);
    return Response.json(
      { error: "Unable to retrieve task definition." },
      { status: 500 },
    );
  }
}

/**
 * `PUT /api/v1/task-definitions/{id}`
 * Body: { expectedRevision: 1, draft: { ...complete edited draft... } }
 *
 * This isn't a "last write wins" update. If someone else already edited
 * revision 1 into revision 2, an expectedRevision of 1 triggers HTTP 409.
 * A friendly Task Builder UI should reload and offer conflict resolution.
 */
export async function PUT(request: Request, context: Ctx) {
  if (!import.meta.env.DEV) {
    return Response.json(
      { error: "Authentication not configured." },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) {
    return Response.json(
      { error: "Invalid task definition ID." },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body." }, { status: 400 });
  }

  const parsed = updateTaskDefinitionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid update.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const taskDefinition = await service.update(
      env.DB,
      id,
      parsed.data.expectedRevision,
      parsed.data.draft,
    );
    return Response.json({ taskDefinition }); // 200 OK; revision increased.
  } catch (error) {
    if (error instanceof TaskDefinitionNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof TaskDefinitionConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }

    console.error("PUT task definition failed", error);
    return Response.json(
      { error: "Unable to update task definition." },
      { status: 500 },
    );
  }
}
