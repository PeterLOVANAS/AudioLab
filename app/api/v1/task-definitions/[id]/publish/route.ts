/**
 * ROUTE: POST /api/v1/task-definitions/[id]/publish
 * -------------------------------------------------
 * "Publish" is an ACTION on a particular definition, not an audio upload.
 * It freezes the current draft into a versioned snapshot for later tasks.
 *
 * Example:
 *  POST /api/v1/task-definitions/<id>/publish
 *  { "expectedRevision": 2, "expectedPublishedVersion": 1 }
 *  -> creates published version 2, IF both counters still match D1.
 *
 * A published snapshot's contents should not change if a teammate later
 * edits the draft. That protects the scientific interpretation of labels.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { publishTaskDefinitionSchema } from "@/lib/backend/validation/task-definitions";
import {
  taskDefinitionService as service,
  TaskDefinitionNotFoundError,
  TaskDefinitionConflictError,
  TaskDefinitionPublicationError,
} from "@/lib/backend/services/task-definitions";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Ctx) {
  // The API proxy authenticates the session and enforces resource ownership.

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

  // Both counters are required to prevent publication of stale content.
  const parsed = publishTaskDefinitionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid publish request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const published = await service.publish(
      env.DB,
      id,
      parsed.data.expectedRevision,
      parsed.data.expectedPublishedVersion,
    );
    return Response.json({ published }, { status: 201 });
  } catch (error) {
    if (error instanceof TaskDefinitionNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof TaskDefinitionPublicationError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof TaskDefinitionConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }

    console.error("POST publish task definition failed", error);
    return Response.json(
      { error: "Unable to publish task definition." },
      { status: 500 },
    );
  }
}
