import { z } from "zod";

/** Whitelist persisted snapshot fields before using them as a worker response. */
const singleSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  definitionId: z.string().min(1),
  definitionVersion: z.number().int().positive(),
  source: z.strictObject({
    kind: z.literal("dataset"),
    projectId: z.string().min(1),
    datasetId: z.string().min(1),
    assetId: z.string().min(1),
    sourceRecordId: z.string().min(1),
    recordId: z.string().min(1),
    sourceUpdatedAt: z.string().min(1),
  }),
  publicFields: z
    .array(
      z.strictObject({
        field: z.strictObject({
          id: z.string().regex(/^(item|sample)\.[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
          type: z.enum(["string", "number", "boolean", "choices", "textgrid"]),
          visibility: z.literal("worker"),
          provenance: z.literal("source_records"),
        }),
        value: z.unknown(),
      }),
    )
    .max(200)
    .optional(),
  trainingPreviews: z
    .array(
      z.strictObject({
        blockId: z.string().min(1),
        fieldId: z.literal("reference_answer"),
        value: z.union([
          z.string().min(1).max(20000),
          z.array(z.string().min(1).max(20000)).min(1).max(50),
        ]),
      }),
    )
    .max(100)
    .optional(),
  question: z
    .string()
    .refine((text) => text.trim().length > 0)
    .optional(),
  choices: z
    .array(z.string().refine((text) => text.trim().length > 0))
    .min(2)
    .max(50)
    .optional(),
});

/** A bounded ordered batch extends the legacy singleton without changing its stored schema version. */
export const taskInputSnapshotSchema = singleSnapshotSchema.extend({
  batch: z.array(singleSnapshotSchema).min(2).max(24).optional(),
});
