/**
 * Lesson 9: HTTP-facing annotation data contracts.
 *
 * We intentionally do NOT replace lib/contracts/annotations.ts, which is
 * an older domain model. This DTO describes what the actual HTTP endpoints
 * currently accept and return. Later we can unify these contracts.
 *
 * Answers are a dictionary keyed by Task Definition block ID. For example:
 *   { "voice_type": "man", "notes": "quiet background" }
 * The published definition, NOT this TypeScript alias, tells us which value
 * types are valid for each key. That validation occurs at runtime in Zod/
 * the service, because a browser may send arbitrary JSON.
 */
export type AnnotationAnswers = Record<string, unknown>;
export type AnnotationRevision = {
  id: string;
  assignmentId: string;
  labellerId: string;
  revision: number;
  expectedRevision: number;
  status: "draft" | "submitted";
  answers: AnnotationAnswers;
  createdAt: string;
};

/** No saved answer yet: current = null, next save uses expectedRevision=0. */
export type AnnotationCurrent = {
  assignmentId: string;
  current: AnnotationRevision | null;
};
