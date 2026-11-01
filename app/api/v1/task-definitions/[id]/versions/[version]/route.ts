/**
 * ROUTE: GET /api/v1/task-definitions/[id]/versions/[version]
 * -------------------------------------------------------------
 * The TWO bracketed names are dynamic URL parameters:
 *   [id]      -> a definition UUID
 *   [version] -> a positive integer in the URL, such as "1" or "2"
 *
 * Unlike GET /task-definitions/:id, this reads a HISTORICAL published
 * snapshot. This distinction is vital: published v1 should keep its
 * original question text even if the draft was later edited for v2.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  taskDefinitionService as service,
  TaskDefinitionNotFoundError,
} from "@/lib/backend/services/task-definitions";

type Ctx = { params: Promise<{ id: string; version: string }> };

export async function GET(_request: Request, context: Ctx) {
  if (!import.meta.env.DEV) {
    return Response.json({ error: "Authentication not configured." }, { status: 403 });
  }

  const { id, version: versionText } = await context.params;

  // URL params are STRINGS. Number() converts "2" -> 2, but could also
  // convert unwanted strings such as "2.5", "0" or "1e2". The regex below
  // requires plain positive decimal digits, and isSafeInteger avoids
  // precision loss for numbers outside JavaScript's safe integer range.
  const version = Number(versionText);
  if (
    !z.uuid().safeParse(id).success ||
    !/^[1-9]\d*$/.test(versionText) ||
    !Number.isSafeInteger(version)
  ) {
    return Response.json(
      { error: "Invalid definition ID or version." },
      { status: 400 }
    );
  }

  try {
    const published = await service.getPublished(env.DB, id, version);
    return Response.json({ published });
  } catch (error) {
    if (error instanceof TaskDefinitionNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("GET published task definition failed", error);
    return Response.json(
      { error: "Unable to retrieve published version." },
      { status: 500 }
    );
  }
}
