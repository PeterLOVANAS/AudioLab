/**
 * POST /api/v1/assignments/{id}/annotation/submit
 *
 * Finalize answers: missing visible required blocks become HTTP 422.
 * On successful INSERT, a SQLite AFTER INSERT trigger marks the assignment
 * submitted atomically; it disappears from the active Labeller queue.
 *
 * Submitted revisions are IMMUTABLE. Any later save returns HTTP 409.
 */
import {
  handleAnnotationWrite,
  type AnnotationRouteContext,
} from "@/lib/backend/http/annotation-routes";

export async function POST(request: Request, context: AnnotationRouteContext) {
  return handleAnnotationWrite(request, context, "submitted");
}
