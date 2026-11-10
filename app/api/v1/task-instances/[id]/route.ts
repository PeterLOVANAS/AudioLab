/**
 * ITEM route: GET /api/v1/task-instances/[id]
 *
 * [id] in the directory name means a dynamic URL parameter.
 * `await context.params` extracts it in modern App Router semantics.
 *
 * Returns a read-only PREVIEW: published blocks + playback URL + optional
 * MMAU source question. NO source_labels or reference answers are returned.
 * This is NOT an assigned Labeller queue or a submission endpoint yet.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  taskInstanceService as service,
  TaskInstanceNotFoundError,
} from "@/lib/backend/services/task-instances";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Ctx) {
  if (!import.meta.env.DEV) {
    return Response.json(
      { error: "Authentication is not configured." },
      { status: 403 },
    );
  }
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) {
    return Response.json(
      { error: "Valid task instance ID required." },
      { status: 400 },
    );
  }
  try {
    const taskInstance = await service.get(env.DB, id);
    return Response.json({ taskInstance });
  } catch (error) {
    if (error instanceof TaskInstanceNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("GET task instance failed", error);
    return Response.json(
      { error: "Unable to retrieve task instance." },
      { status: 500 },
    );
  }
}
