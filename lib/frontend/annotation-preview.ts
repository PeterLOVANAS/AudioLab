import type {
  SourceFieldPayload,
  SourcePreviewPayload,
  WorkerSourcePayload,
} from "@/lib/contracts/source-fields";
/** Builder-only display model. Mock values have no answer shape and never seed drafts.
 * An absent original annotation is distinct from an unavailable protected reference.
 */
export function annotationPreview(
  source:
    SourceFieldPayload | WorkerSourcePayload | SourcePreviewPayload | null,
): { kind: "actual" | "mock" | "unavailable"; text: string } {
  if (!source)
    return { kind: "unavailable", text: "Select an authorized source item" };
  const annotation = source.fields.find(
    (f) => f.field.id === "early_annotation",
  );
  if (annotation)
    return { kind: "actual", text: JSON.stringify(annotation.value, null, 2) };
  if (
    ("access" in source && source.access !== "admin") ||
    !("projectId" in source)
  )
    return {
      kind: "unavailable",
      text: "Original annotations are restricted to admin preview; reference answers remain hidden",
    };
  return {
    kind: "mock",
    text: "MOCK / BUILDER SAMPLE ONLY — Example annotation. No existing annotation is stored for this item. Protected reference answers are separate.",
  };
}
