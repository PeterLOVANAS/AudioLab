import { z } from "zod";
const unique = (values: string[]) => new Set(values).size === values.length;
/** Bound request size and reject duplicate identities before SQL or allocation. */
export const allocationSchema = z.strictObject({
  projectId: z.uuid(),
  adminId: z.string().trim().min(1).max(128),
  datasetId: z.uuid(),
  definitionId: z.uuid(),
  definitionVersion: z.number().int().positive(),
  itemKeys: z
    .array(z.string().min(1).max(1000))
    .min(1)
    .max(50)
    .refine(unique, "Duplicate items"),
  labellerIds: z
    .array(z.string().trim().min(1).max(128))
    .min(1)
    .max(20)
    .refine(unique, "Duplicate workers"),
  independentLabellers: z.number().int().min(1).max(20),
  mode: z.enum(["fixed", "balanced"]),
});
export const confirmAllocationSchema = allocationSchema.extend({
  pairs: z
    .array(
      z.strictObject({
        itemKey: z.string().min(1).max(1000),
        labellerId: z.string().min(1).max(128),
      }),
    )
    .min(1)
    .max(500),
});
