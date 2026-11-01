/**
 * LOCAL DEVELOPMENT endpoint for project member fixtures:
 *   GET  /api/v1/project-members?projectId=<uuid>
 *   POST /api/v1/project-members
 *
 * It creates relational membership records ONLY. This does not authenticate
 * a person; DO NOT expose this endpoint publicly until proper admin auth exists.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { createMemberSchema } from "@/lib/backend/validation/assignments";
import {
  assignmentService as service,
  AssignmentRelatedNotFoundError,
  AssignmentConflictError,
} from "@/lib/backend/services/assignments";

// Every handler is explicitly disabled outside development until auth exists.
function devOnly(): Response | null {
  return import.meta.env.DEV ? null : Response.json(
    { error: "Authentication is not configured." }, { status: 403 }
  );
}

export async function GET(request: Request) {
  const denied = devOnly(); if (denied) return denied;
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!z.uuid().safeParse(projectId).success) {
    return Response.json({ error: "Valid projectId required." }, { status: 400 });
  }
  try {
    const members = await service.listMembers(env.DB, projectId!);
    return Response.json({ members });
  } catch (error) {
    if (error instanceof AssignmentRelatedNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("GET project members failed:", error);
    return Response.json({ error: "Unable to list project members." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = devOnly(); if (denied) return denied;
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Expected JSON body." }, { status: 400 }); }
  const parsed = createMemberSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid member data.", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const member = await service.addMember(env.DB, parsed.data);
    return Response.json({ member }, { status: 201 });
  } catch (error) {
    if (error instanceof AssignmentRelatedNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof AssignmentConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("POST project member failed:", error);
    return Response.json({ error: "Unable to create project member." }, { status: 500 });
  }
}
