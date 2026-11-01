/**
 * Shared HTTP translation for /draft and /submit. Both accept identical JSON;
 * the only difference is whether the validator requires all visible required
 * blocks to be answered, and whether the assignment becomes submitted.
 *
 * Using POST action routes (instead of a generic PUT) also makes each intent
 * explicit and avoids mixing "save a draft" with "finalize submission".
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { annotationWriteSchema } from "@/lib/backend/validation/annotations";
import {
  annotationService,
  AnnotationAssignmentNotFoundError,
  AnnotationLabellerMismatchError,
  AnnotationConflictError,
  AnnotationAnswerError,
} from "@/lib/backend/services/annotations";

export type AnnotationRouteContext = { params: Promise<{ id: string }> };

/** All endpoints in this lesson are disabled in production until auth exists. */
export function devOnly(): Response | null {
  return import.meta.env.DEV ? null : Response.json(
    { error: "Authentication is not configured." }, { status: 403 }
  );
}

/** Centralize HTTP error mapping; unexpected DB errors still appear in logs. */
export function annotationHttpError(error: unknown): Response {
  if (error instanceof AnnotationAssignmentNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof AnnotationLabellerMismatchError) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof AnnotationConflictError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof AnnotationAnswerError) {
    return Response.json({ error: error.message, issues: error.issues }, { status: 422 });
  }
  console.error("Annotation endpoint failed:", error);
  return Response.json({ error: "Unable to process annotation." }, { status: 500 });
}

/** Called only by real POST handlers in the two action routes. */
export async function handleAnnotationWrite(
  request: Request,
  context: AnnotationRouteContext,
  status: "draft" | "submitted"
): Promise<Response> {
  const denied = devOnly(); if (denied) return denied;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: "Invalid assignment ID." }, { status: 400 });
  }
  let payload: unknown;
  try { payload = await request.json(); }
  catch { return Response.json({ error: "Expected JSON body." }, { status: 400 }); }

  // Form data supplied by a browser is untrusted even if the frontend is TS.
  const parsed = annotationWriteSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: "Invalid annotation request.", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const annotation = await annotationService.save(env.DB, id, parsed.data, status);
    return Response.json({ annotation }, { status: 201 });
  } catch (error) {
    return annotationHttpError(error);
  }
}
