import { z } from "zod";

/** Scalar/ordered-label content supports text, choices, ratings and Ranking without author metadata. */
export const candidateValueSchema = z.union([
  z.string().min(1).max(20000).refine((value) => value.trim().length > 0), z.number(), z.boolean(),
  z.array(z.string().min(1).max(20000)).min(1).max(100),
]).refine((value) => JSON.stringify(value).length <= 32768, "Candidate content is too large.");

/** Creation accepts immutable references; payload values and policy are derived on the server. */
export const createCandidateSetSchema = z.strictObject({
  projectId: z.uuid(),
  taskInstanceId: z.uuid(),
  blockId: z.string().min(1).max(80),
  userId: z.string().trim().min(1).max(128),
  requestId: z.string().min(1).max(128),
  sources: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("dataset_annotation"), labelId: z.string().min(1).max(1000),
      field: z.enum(["value", "text", "transcript", "label", "sound_label"]).optional() }),
    z.strictObject({ kind: z.literal("submission"), revisionId: z.uuid(), blockId: z.string().min(1).max(80) }),
    z.strictObject({ kind: z.literal("curated"), candidateId: z.uuid() }),
  ])).min(2).max(20),
});
export type CreateCandidateSetInput = z.infer<typeof createCandidateSetSchema>;
