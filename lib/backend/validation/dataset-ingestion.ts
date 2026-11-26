import { parseTextGrid } from "@/lib/audio/textgrid";
import { z } from "zod";
const id = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9_.-]+$/);
const choice = z.strictObject({ id, label: z.string().min(1).max(2000) });
/** Explicit types and visibility replace format-specific field-name guessing. */
export const sourceValueSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("textgrid"),
    file: z
      .strictObject({
        name: z
          .string()
          .min(1)
          .max(255)
          .refine(
            (name) => !/[\\/\u0000-\u001f]/.test(name),
            "Use a filename, not a path",
          ),
        media_type: z.literal("text/praat-textgrid"),
        encoding: z.enum(["utf-8", "utf-16le", "utf-16be"]),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        content_base64: z
          .string()
          .min(1)
          .max(280000)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          ),
      })
      .optional(),
    visibility: z.enum(["worker", "admin"]),
    value: z
      .string()
      .max(200000)
      .refine((text) => {
        try {
          const grid = parseTextGrid(text);
          return (
            grid.tiers.length > 0 &&
            new Set(grid.tiers.map((t) => t.name)).size === grid.tiers.length &&
            grid.tiers.every((t) => t.type === "IntervalTier" && t.name.trim())
          );
        } catch {
          return false;
        }
      }, "Invalid or unsupported interval TextGrid"),
  }),
  z.strictObject({
    type: z.literal("text"),
    value: z.string().max(20000),
    visibility: z.enum(["worker", "admin"]),
  }),
  z.strictObject({
    type: z.literal("number"),
    value: z.number().finite(),
    visibility: z.enum(["worker", "admin"]),
  }),
  z.strictObject({
    type: z.literal("boolean"),
    value: z.boolean(),
    visibility: z.enum(["worker", "admin"]),
  }),
  z.strictObject({
    type: z.literal("choices"),
    value: z.array(choice).min(2).max(50),
    visibility: z.enum(["worker", "admin"]),
  }),
]);
const fields = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), sourceValueSchema)
  .refine(
    (value) => Object.keys(value).length <= 100,
    "Maximum 100 fields per scope",
  );
const answer = z.strictObject({
  field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});
/** Bounded v1 import. Replacement is deliberately unsupported; revisions use new identity. */
export const ingestionSchema = z
  .strictObject({
    schema_version: z.literal(1),
    dataset_id: z.uuid(),
    source_version: id,
    provenance: z.strictObject({ origin: id, revision: id }),
    records: z
      .array(
        z.strictObject({
          sample_id: id,
          audio_id: z.uuid(),
          fields: fields.default({}),
          metadata: z.record(z.string(), z.unknown()).default({}),
          items: z
            .array(
              z.strictObject({
                item_id: id,
                fields,
                annotations: z.array(answer).max(20).default([]),
                reference: answer.optional(),
              }),
            )
            .min(1)
            .max(20),
        }),
      )
      .min(1)
      .max(20),
  })
  .superRefine((data, ctx) => {
    // Sample and item namespaces are independent. Never merge them here:
    // equal field names must not hide a malformed collection in either scope.
    function validateChoices(
      values: z.infer<typeof fields>,
      path: Array<string | number>,
    ) {
      for (const [name, field] of Object.entries(values)) {
        if (field.type === "textgrid") {
          try {
            const grid = parseTextGrid(field.value);
            if (grid.tiers.some((t) => t.type !== "IntervalTier"))
              throw new Error();
          } catch {
            ctx.addIssue({
              code: "custom",
              path: [...path, name, "value"],
              message: "Invalid or unsupported interval TextGrid",
            });
          }
        }
        if (
          field.type === "choices" &&
          new Set(field.value.map((choice) => choice.id)).size !==
            field.value.length
        )
          ctx.addIssue({
            code: "custom",
            path: [...path, name, "value"],
            message: "Duplicate choice IDs",
          });
      }
    }
    const samples = new Set<string>();
    data.records.forEach((r, i) => {
      if (samples.has(r.sample_id))
        ctx.addIssue({
          code: "custom",
          path: ["records", i, "sample_id"],
          message: "Duplicate sample ID",
        });
      samples.add(r.sample_id);
      validateChoices(r.fields, ["records", i, "fields"]);
      const items = new Set<string>();
      r.items.forEach((item, j) => {
        const path = ["records", i, "items", j];
        if (items.has(item.item_id))
          ctx.addIssue({
            code: "custom",
            path: [...path, "item_id"],
            message: "Duplicate item ID",
          });
        items.add(item.item_id);
        if (!Object.keys(item.fields).length)
          ctx.addIssue({
            code: "custom",
            path: [...path, "fields"],
            message: "At least one item field is required",
          });
        validateChoices(item.fields, [...path, "fields"]);
        for (const a of [
          ...item.annotations,
          ...(item.reference ? [item.reference] : []),
        ]) {
          const f = item.fields[a.field];
          if (!f)
            ctx.addIssue({
              code: "custom",
              path: [
                ...path,
                a === item.reference ? "reference" : "annotations",
              ],
              message: "Answer field does not exist in item fields",
            });
          else if (
            f.type !== "choices" &&
            typeof a.value !==
              (["text", "textgrid"].includes(f.type) ? "string" : f.type)
          )
            ctx.addIssue({
              code: "custom",
              path: [...path, "reference"],
              message: "Answer type does not match source field",
            });
          else if (
            f.type === "choices"
              ? !(Array.isArray(a.value) ? a.value : [a.value]).every((v) =>
                  f.value.some((c) => c.id === v),
                )
              : typeof a.value !==
                (["text", "textgrid"].includes(f.type) ? "string" : f.type)
          )
            ctx.addIssue({
              code: "custom",
              path: [
                ...path,
                a === item.reference ? "reference" : "annotations",
              ],
              message: "Answer type or option reference is invalid",
            });
        }
      });
    });
    if (data.records.reduce((n, r) => n + r.items.length, 0) > 50)
      ctx.addIssue({
        code: "custom",
        path: ["records"],
        message: "Maximum 50 items per batch",
      });
  });
export type CanonicalImport = z.infer<typeof ingestionSchema>;
