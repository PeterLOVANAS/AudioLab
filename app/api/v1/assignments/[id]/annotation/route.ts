/**
 * GET /api/v1/assignments/{id}/annotation?labellerId=...
 *
 * Returns the latest human annotation revision or null if no draft exists.
 * The Labeller UI reads `current.revision` and sends it back as
 * `expectedRevision` on its next write. That enables optimistic locking.
 *
 * DEMO SECURITY: labellerId is caller-supplied for LOCAL testing only.
 * In production this must come from a verified login session.
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
    const data = await annotationService.current(env.DB, id, labellerId);
    return Response.json(data);
  } catch (error) {
    return annotationHttpError(error);
  }
}
