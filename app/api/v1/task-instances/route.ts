/**
 * COLLECTION route: /api/v1/task-instances
 *
 * GET  ?projectId=... [&datasetId=...] -> list compact task summaries.
 * POST JSON -> create ONE real instance for published definition + WAV.
 *
 * Same App Router/Vinext convention as existing /task-definitions.
 * A dev-only gate is NOT authentication. Do not deploy publicly yet.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { createTaskInstanceSchema } from "@/lib/backend/validation/task-instances";
import {
  taskInstanceService as service,
  TaskInstanceRelatedNotFoundError,
  TaskInstanceProjectMismatchError,
  TaskInstanceConflictError,
} from "@/lib/backend/services/task-instances";

function devOnly(): Response | null {
  return import.meta.env.DEV
    ? null
    : Response.json(
        { error: "Authentication is not configured." },
        { status: 403 },
      );
}

export async function GET(request: Request) {
  const denied = devOnly();
  if (denied) return denied;
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const datasetId = url.searchParams.get("datasetId");
  if (
    !z.uuid().safeParse(projectId).success ||
    (datasetId !== null && !z.uuid().safeParse(datasetId).success)
  ) {
    return Response.json(
      { error: "Valid projectId and optional datasetId required." },
      { status: 400 },
    );
  }
  try {
    const instances = await service.list(
      env.DB,
      projectId!,
      datasetId ?? undefined,
    );
    return Response.json({ instances });
  } catch (error) {
    if (error instanceof TaskInstanceRelatedNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof TaskInstanceProjectMismatchError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("GET task instances failed", error);
    return Response.json(
      { error: "Unable to list task instances." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = devOnly();
  if (denied) return denied;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON request." }, { status: 400 });
  }

  // Runtime validation: a caller must use published version N, not a string.
  const result = createTaskInstanceSchema.safeParse(raw);
  if (!result.success) {
    return Response.json(
      { error: "Invalid task instance.", issues: result.error.issues },
      { status: 400 },
    );
  }
  try {
    const taskInstance = await service.create(env.DB, result.data);
    return Response.json({ taskInstance }, { status: 201 });
  } catch (error) {
    if (error instanceof TaskInstanceRelatedNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof TaskInstanceProjectMismatchError ||
      error instanceof TaskInstanceConflictError
    ) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("POST task instance failed", error);
    return Response.json(
      { error: "Unable to create task instance." },
      { status: 500 },
    );
  }
}
