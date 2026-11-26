/**
 * GET /api/v1/assignments/{id}/annotation/revisions?labellerId=...
 *
 * Returns append-only human answer history for this assignment, oldest first.
 * Audit records never include original MMAU reference answers or votes from
 * other labellers. The current dev identity is NOT real authorization.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { annotationService } from "@/lib/backend/services/annotations";
import {
  devOnly,
  annotationHttpError,
  type AnnotationRouteContext,
} from "@/lib/backend/http/annotation-routes";

export async function GET(request: Request, context: AnnotationRouteContext) {
  const denied = devOnly();
  if (denied) return denied;
  const { id } = await context.params;
  const labellerId = new URL(request.url).searchParams.get("labellerId");
  if (
    !z.uuid().safeParse(id).success ||
    !labellerId ||
    labellerId.length > 128
  ) {
    return Response.json(
      { error: "Valid assignment ID and labellerId required." },
      { status: 400 },
    );
  }
  try {
    const revisions = await annotationService.history(env.DB, id, labellerId);
    return Response.json({ revisions });
  } catch (error) {
    return annotationHttpError(error);
  }
}
