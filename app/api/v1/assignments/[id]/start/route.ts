/**
 * POST /api/v1/assignments/[id]/start
 * Body: { "labellerId": "demo-user-123" }
 *
 * In this local DEV lesson, the caller provides a labellerId explicitly.
 * This is a demonstration identity, NOT authentication. A deployed service
 * must determine the acting labeller from their verified session instead.
 *
 * Only transition allowed here: assigned -> in_progress.
 * Submission/review transitions must wait for real annotation persistence.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { startAssignmentSchema } from "@/lib/backend/validation/assignments";
import {
  assignmentService as service,
  AssignmentNotFoundError,
  AssignmentConflictError,
} from "@/lib/backend/services/assignments";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Ctx) {
  if (!import.meta.env.DEV) {
    return Response.json(
      { error: "Authentication is not configured." },
      { status: 403 },
    );
  }
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) {
    return Response.json(
      { error: "Valid assignment ID required." },
      { status: 400 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body." }, { status: 400 });
  }
  const parsed = startAssignmentSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid start request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const assignment = await service.start(env.DB, id, parsed.data.labellerId);
    return Response.json({ assignment });
  } catch (error) {
    if (error instanceof AssignmentNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof AssignmentConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("POST assignment start failed:", error);
    return Response.json(
      { error: "Unable to start assignment." },
      { status: 500 },
    );
  }
}
