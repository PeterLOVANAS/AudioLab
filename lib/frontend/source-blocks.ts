import { newBlock, type Block } from "@/components/task-builder/model";
import type { SourceFieldPayload } from "@/lib/contracts/source-fields";
import { parseTextGrid } from "@/lib/audio/textgrid";

/** Map an explicitly selected typed source into a reusable block, not copied
 * sample answers. Field names are opaque: question/description associations are
 * selected once by the author and reused for each item. Hidden fields are denied.
 */
export function blockFromSource(
  source: SourceFieldPayload,
  fieldId: string,
  settings: {
    questionId?: string;
    descriptionId?: string;
    editableText?: boolean; multipleChoices?: boolean;
  } = {},
): Block {
  const field = source.fields.find(
    (f) => f.field.id === fieldId && f.field.visibility === "worker",
  );
  if (!field)
    throw new Error("Choose an available worker-visible source field");
  const binding = { kind: "dataset" as const, fieldId, type: field.field.type };
  let block: Block;
  if (binding.type === "choices" || binding.type === "string[]") {
    block = newBlock(settings.multipleChoices ? "multiple_choice" : "single_choice");
    block.sourceBindings = { options: { ...binding, type: binding.type } };
  } else if (binding.type === "textgrid") {
    if (typeof field.value !== "string")
      throw new Error("TextGrid source must be text");
    const grid = parseTextGrid(field.value);
    if (
      !grid.tiers.length ||
      new Set(grid.tiers.map((t) => t.name)).size !== grid.tiers.length ||
      grid.tiers.some((t) => t.type !== "IntervalTier" || !t.name.trim())
    )
      throw new Error("Only interval TextGrid tiers are supported");
    block = newBlock("timeline_annotation");
    block.tiers = grid.tiers.map((t, i) => ({
      id: `grid-${i + 1}`,
      name: t.name,
      kind: "interval",
      labelMode: "text",
      allowOverlap: true,
    }));
    block.sourceBindings = {
      value: { ...binding, type: "textgrid", mode: "prefill" },
    };
  } else if (binding.type === "string") {
    block = newBlock("text");
    block.required = !!settings.editableText;
    block.sourceBindings = {
      value: {
        ...binding,
        type: "string",
        mode: settings.editableText ? "prefill" : "read_only",
      },
    };
  } else
    throw new Error(
      "Select text, choices or TextGrid for automatic block mapping",
    );
  block.label = fieldId;
  for (const [target, id] of [
    ["label", settings.questionId],
    ["helpText", settings.descriptionId],
  ] as const) {
    if (!id) continue;
    const text = source.fields.find(
      (f) =>
        f.field.id === id &&
        f.field.visibility === "worker" &&
        f.field.type === "string",
    );
    if (!text)
      throw new Error("Question/description must be a visible text field");
    block.sourceBindings = {
      ...block.sourceBindings,
      [target]: { kind: "dataset", fieldId: id, type: "string" },
    };
  }
  return block;
}
