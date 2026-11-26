import { z } from "zod";
const ids = z
  .array(z.string().min(1).max(1000))
  .min(1)
  .max(200)
  .refine(
    (values) => new Set(values).size === values.length,
    "Duplicate identities",
  );
/** Explicit job scopes and a reproducible shuffle seed; no client choice data. */
export const jobInputSchema = z.strictObject({
  jobId: z.uuid(),
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  teamId: z.uuid().optional(),
  datasetId: z.uuid(),
  definitionId: z.uuid(),
  definitionVersion: z.number().int().positive(),
  mode: z.enum(["individual", "voting"]),
  seed: z.string().min(1).max(80),
  itemKeys: z.array(z.string().min(1).max(1000)).max(50).refine(values=>new Set(values).size===values.length,"Duplicate identities"),
  useEntireDataset:z.boolean().optional(),
  workerIds: ids.max(20),
  sampleCount: z.number().int().min(1).max(1000),
}).refine(input=>input.useEntireDataset || (input.itemKeys.length>0 && input.sampleCount<=50),"Select 1–50 source items, or use the entire dataset.");
export const workerProfileSchema = z.strictObject({
  projectId: z.uuid(),
  userId: z.string().min(1).max(128),
  country: z.string().trim().max(80),
  profession: z.string().trim().max(120),
  languages: z.array(z.string().trim().min(1).max(60)).max(20),
  experienceYears: z.number().int().min(0).max(100),
  active: z.boolean(),
  metadata: z
    .record(z.string().max(60), z.string().max(200))
    .refine((value) => Object.keys(value).length <= 20),
});
export const teamSchema = z.strictObject({
  projectId: z.uuid(),
  teamId: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  memberIds: ids.max(20),
});
