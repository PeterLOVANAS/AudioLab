/**
 * POST /api/v1/assignments/{id}/annotation/draft
 *
 * Save a PARTIAL answer set. Required blocks can be missing; any supplied
 * answer still must obey the published definition's type and options.
 * The database automatically moves assigned -> in_progress on first save.
 *
 * Body: { labellerId, expectedRevision, answers: {blockId: value} }
 */
import {
  handleAnnotationWrite,
  type AnnotationRouteContext,
} from "@/lib/backend/http/annotation-routes";

export async function POST(request: Request, context: AnnotationRouteContext) {
  return handleAnnotationWrite(request, context, "draft");
}
