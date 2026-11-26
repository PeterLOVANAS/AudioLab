/**
 * GET /api/v1/labeller/queue?projectId=<uuid>&labellerId=<user-id>
 *
 * Returns ONLY this labeller's assigned/in-progress work from ONE project.
 * The client can click a row and fetch /api/v1/assignments/<id> for its full
 * published blocks and audio playback URL.
 *
 * IMPORTANT: caller-supplied labellerId is NOT secure identity; dev only.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  assignmentService as service,
  AssignmentRelatedNotFoundError,
  AssignmentRoleError,
} from "@/lib/backend/services/assignments";

export async function GET(request: Request) {
  // The API proxy authenticates the session and enforces resource ownership.
  const params = new URL(request.url).searchParams;
  const projectId = params.get("projectId");
  const labellerId = params.get("labellerId");
  if (
    !z.uuid().safeParse(projectId).success ||
    !labellerId ||
    labellerId.trim().length < 1 ||
    labellerId.length > 128
  ) {
    return Response.json(
      { error: "Valid projectId and labellerId required." },
      { status: 400 },
    );
  }
  try {
    const assignments = await service.queue(env.DB, projectId!, labellerId);
    return Response.json({ assignments });
  } catch (error) {
    if (error instanceof AssignmentRelatedNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof AssignmentRoleError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("GET labeller queue failed:", error);
    return Response.json({ error: "Unable to list queue." }, { status: 500 });
  }
}
