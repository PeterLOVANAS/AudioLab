import { env } from "cloudflare:workers";
import { z } from "zod";
import { candidateSetService } from "@/lib/backend/services/candidate-sets";
import { devOnly, annotationHttpError, type AnnotationRouteContext } from "@/lib/backend/http/annotation-routes";

/**
 * GET anonymous eligible candidates for this assignment's actual owner.
 * Private source references and other workers' identities are never serialized.
 * Matching a local supplied ID is not session authentication; production is gated.
 */
export async function GET(request: Request, context: AnnotationRouteContext) {
  const denied = devOnly();
  if (denied) return denied;
  const { id } = await context.params;
  const user = z.string().trim().min(1).max(128).safeParse(new URL(request.url).searchParams.get("labellerId"));
  if (!z.uuid().safeParse(id).success || !user.success)
    return Response.json({ error: "Valid assignment ID and labellerId required." }, { status: 400 });
  try {
    const result = await candidateSetService.forAssignment(env.DB,id,user.data);
    return Response.json({ candidateSets: result.candidateSets });
  } catch (error) { return annotationHttpError(error); }
}
