/**
 * Authenticated project-admin collection endpoint:
 *  GET /api/v1/assignments?projectId=<uuid>[&labellerId=...]
 *  POST /api/v1/assignments
 *
 * This does NOT submit annotation answers. It links an existing Lesson 7
 * task instance to a persistent project_member with the 'labeller' role.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { createAssignmentSchema } from "@/lib/backend/validation/assignments";
import {
  assignmentService as service,
  AssignmentRelatedNotFoundError,
  AssignmentProjectMismatchError,
  AssignmentRoleError,
  AssignmentConflictError,
} from "@/lib/backend/services/assignments";

// Session identity and resource permissions are enforced by the mandatory API proxy.

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const projectId = params.get("projectId");
  const labellerId = params.get("labellerId");
  if (
    !z.uuid().safeParse(projectId).success ||
    (labellerId !== null &&
      (labellerId.trim().length < 1 || labellerId.length > 128))
  ) {
    return Response.json(
      { error: "Valid projectId and optional labellerId required." },
      { status: 400 },
    );
  }
  try {
    const assignments = await service.list(
      env.DB,
      projectId!,
      labellerId ?? undefined,
    );
    return Response.json({ assignments });
  } catch (error) {
    if (error instanceof AssignmentRelatedNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("GET assignments failed:", error);
    return Response.json(
      { error: "Unable to list assignments." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body." }, { status: 400 });
  }
  const parsed = createAssignmentSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid assignment.", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const assignment = await service.create(env.DB, parsed.data);
    return Response.json({ assignment }, { status: 201 });
  } catch (error) {
    if (error instanceof AssignmentRelatedNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof AssignmentProjectMismatchError ||
      error instanceof AssignmentRoleError ||
      error instanceof AssignmentConflictError
    ) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("POST assignment failed:", error);
    return Response.json(
      { error: "Unable to create assignment." },
      { status: 500 },
    );
  }
}
