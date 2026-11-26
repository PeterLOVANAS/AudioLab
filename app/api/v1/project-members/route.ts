/**
 * Authenticated project membership management:
 *   GET  /api/v1/project-members?projectId=<uuid>
 *   POST /api/v1/project-members
 *
 * Creates membership only. Production targets must already have an active
 * provisioned account; external identity linking is an operator action.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { createMemberSchema } from "@/lib/backend/validation/assignments";
import {
  assignmentService as service,
  AssignmentRelatedNotFoundError,
  AssignmentConflictError,
} from "@/lib/backend/services/assignments";

// Session identity and resource permissions are enforced by the mandatory API proxy.

export async function GET(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!z.uuid().safeParse(projectId).success) {
    return Response.json(
      { error: "Valid projectId required." },
      { status: 400 },
    );
  }
  try {
    const members = await service.listMembers(env.DB, projectId!);
    return Response.json({ members });
  } catch (error) {
    if (error instanceof AssignmentRelatedNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("GET project members failed:", error);
    return Response.json(
      { error: "Unable to list project members." },
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
  const parsed = createMemberSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid member data.", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    if (
      !import.meta.env.DEV &&
      !(await env.DB.prepare(
        "SELECT 1 FROM auth_accounts a WHERE user_id=? AND active=1 AND EXISTS(SELECT 1 FROM auth_identity_links l WHERE l.user_id=a.user_id AND l.issuer=?)",
      )
        .bind(parsed.data.userId, env.ACCESS_TEAM_DOMAIN)
        .first())
    )
      return Response.json(
        {
          error:
            "Provision an active Access-linked account before granting project membership.",
        },
        { status: 422 },
      );
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
    return Response.json(
      { error: "Unable to create project member." },
      { status: 500 },
    );
  }
}
