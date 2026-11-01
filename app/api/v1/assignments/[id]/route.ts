/**
 * GET /api/v1/assignments/[id] — read a single assignment AND its published
 * Task Instance preview (including audioUrl, blocks, and optional MMAU question).
 * Never exposes source_labels / correct answers or another labeller's work.
 *
 * [id] is a dynamic route segment. Vinext/Next exposes the params as a Promise.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  assignmentService as service, AssignmentNotFoundError,
} from "@/lib/backend/services/assignments";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Ctx) {
  if (!import.meta.env.DEV) {
    return Response.json({ error: "Authentication is not configured." }, { status: 403 });
  }
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: "Valid assignment ID required." }, { status: 400 });
  }
  try {
    const detail = await service.detail(env.DB, id);
    return Response.json(detail);
  } catch (error) {
    if (error instanceof AssignmentNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("GET assignment detail failed:", error);
    return Response.json({ error: "Unable to retrieve assignment." }, { status: 500 });
  }
}
