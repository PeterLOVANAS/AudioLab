/**
 * Task Instances — external input validation.
 *
 * Why Zod when TypeScript already checks types?
 * JSON arrives from HTTP at runtime, after TypeScript types are erased.
 * Zod rejects strings masquerading as UUIDs and versions like "one".
 *
 * Note: a syntactically valid UUID may not exist in D1. The service checks
 * real database relationships AFTER this schema succeeds.
 */
import { z } from "zod";

/** The project owns the task; the definition and asset must belong to it. */
export const createTaskInstanceSchema = z.strictObject({
  projectId: z.uuid(),
  definitionId: z.uuid(),
  definitionVersion: z.number().int().min(1),
  assetId: z.uuid(),
  /** Optional ORDERED batch, first element must equal assetId; 24 max. */
  audioAssetIds: z.array(z.uuid()).min(2).max(24).optional(),
  // Original MMAU source_record_id, not its AudioLab internal D1 row ID.
  // Omit this to create a new task based only on the audio recording.
  sourceRecordIds: z
    .array(z.string().trim().min(1).max(200))
    .min(2)
    .max(24)
    .optional(),
  sourceRecordId: z.string().trim().min(1).max(200).optional(),
});

export type CreateTaskInstanceInput = z.infer<typeof createTaskInstanceSchema>;
