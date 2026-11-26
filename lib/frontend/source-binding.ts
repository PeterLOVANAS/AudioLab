import { normalizeSourceChoices } from "@/lib/frontend/choice-source";
import { parseTextGrid } from "@/lib/audio/textgrid";
import { validateTimelineAnswer } from "@/lib/backend/validation/timeline-answers";
import type { Block } from "@/components/task-builder/model";
import type {
  SourceFieldPayload,
  WorkerSourcePayload,
} from "@/lib/contracts/source-fields";
import type { DatasetTextBinding } from "@/lib/contracts/input-bindings";

/** Actionable source errors shared by Builder preview, task creation and answer APIs. */
export class BindingResolutionError extends Error {}

/** True only for active targets; an empty bindings object leaves static forms unchanged. */
export function hasSourceBindings(
  blocks: Array<{ id: string; sourceBindings?: unknown }>,
): boolean {
  return blocks.some(
    (block) =>
      block.sourceBindings &&
      typeof block.sourceBindings === "object" &&
      Object.values(block.sourceBindings).some(Boolean),
  );
}

/**
 * Resolve T02 bindings from a public projection, on both server and frontend.
 *
 * Ordinal IDs source-choice-1..N are stable within the pinned Task Instance;
 * their text/meaning is stored in its immutable input snapshot. Display labels
 * are never identities. No admin-only fields are read, even in Builder previews.
 * Resolution returns new blocks and never alters a published definition.
 * Missing values block by default; an explicit fallback must opt into replacement.
 */
export function resolveBoundBlocks(
  blocks: Block[],
  source: SourceFieldPayload | WorkerSourcePayload | null,
): Block[] {
  return blocks.map((block) => {
    if (
      !block.sourceBindings ||
      !Object.values(block.sourceBindings).some(Boolean)
    )
      return block;
    const bindings = block.sourceBindings;
    if (!source)
      throw new BindingResolutionError(
        "Select an available source record to resolve bound fields.",
      );
    function fieldValue(id: string, type: string) {
      const field = source!.fields.find(
        (entry) => entry.field.id === id && entry.field.visibility === "worker",
      );
      if (field && field.field.type !== type)
        throw new BindingResolutionError(
          `Source field ${id} has the wrong type.`,
        );
      return field?.value;
    }
    function text(
      binding: DatasetTextBinding,
      fallback?: string,
    ): string | undefined {
      const raw = fieldValue(binding.fieldId, binding.type);
      if (raw !== undefined && typeof raw !== "string")
        throw new BindingResolutionError("Bound source value must be text.");
      if (typeof raw === "string" && raw.trim()) return raw;
      switch (binding.missingValuePolicy ?? "block") {
        case "use_default":
          return fallback;
        case "empty":
          return "";
        default:
          throw new BindingResolutionError(
            "Source field question is unavailable or empty.",
          );
      }
    }
    // Published snapshots can predate today's request schema. Fail closed for
    // unsupported target/source combinations rather than trusting passthrough JSON.
    for (const [target, binding] of Object.entries(bindings)) {
      if (target === "preview") continue; // Validated separately; only a public, explicitly typed field is readable.
      if (
        binding &&
        (binding.kind !== "dataset" ||
          (target === "options"
            ? !(
                binding.fieldId === "choices" ||
                /^(item|sample)\.[a-zA-Z][a-zA-Z0-9_]*$/.test(binding.fieldId)
              ) || !["string[]", "choices", "string"].includes(binding.type)
            : !(
                binding.fieldId === "question" ||
                /^(item|sample)\.[a-zA-Z][a-zA-Z0-9_]*$/.test(binding.fieldId)
              ) ||
              (target === "value"
                ? !["string", "textgrid"].includes(binding.type)
                : binding.type !== "string")))
      )
        throw new BindingResolutionError(
          "Incompatible or restricted dataset binding.",
        );
    }
    const resolved: Block = { ...block };
    if (bindings.preview && block.showSourceAnswer) {
      if (
        bindings.preview.fieldId === "reference_answer" &&
        !block.trainingAnswerPreview
      )
        throw new BindingResolutionError(
          "Reference preview requires explicit training mode.",
        );
      const value = fieldValue(bindings.preview.fieldId, bindings.preview.type);
      if (value === undefined)
        throw new BindingResolutionError(
          "Selected source answer is unavailable or protected.",
        );
      resolved.sourceAnswerPreview = value;
    }
    if (bindings.label)
      resolved.label =
        text(bindings.label, block.label) || "Source field unavailable";
    if (bindings.helpText)
      resolved.helpText = text(bindings.helpText, block.helpText);
    if (bindings.options) {
      if (block.type !== "single_choice" && block.type !== "multiple_choice")
        throw new BindingResolutionError(
          "Dataset choices require a choice question.",
        );
      const choices = fieldValue(
        bindings.options.fieldId,
        bindings.options.type,
      );
      if (
        choices === undefined &&
        bindings.options.missingValuePolicy === "use_default"
      ) {
        if (!block.options?.length)
          throw new BindingResolutionError("Default choices are unavailable.");
      } else {
        if (choices === undefined)
          throw new BindingResolutionError(
            "Source field choices is unavailable.",
          );
        try {
          resolved.options = normalizeSourceChoices(
            choices,
            bindings.options.format ?? "array",
            bindings.options.delimiter,
            bindings.options.stripPrefix,
          );
        } catch (error) {
          throw new BindingResolutionError(
            error instanceof Error ? error.message : "Invalid source choices",
          );
        }
      }
    }
    if (bindings.value) {
      const binding = bindings.value;
      if (binding.type === "textgrid") {
        if (block.type !== "timeline_annotation" || binding.mode !== "prefill")
          throw new BindingResolutionError(
            "TextGrid requires timeline prefill",
          );
        const raw = fieldValue(binding.fieldId, "textgrid");
        if (typeof raw !== "string")
          throw new BindingResolutionError("TextGrid source is unavailable");
        const grid = parseTextGrid(raw);
        const tiers: Record<
          string,
          Array<{ id: string; start: number; end: number; text: string }>
        > = {};
        for (const [index, tier] of (block.tiers ?? []).entries()) {
          const sourceTier = grid.tiers.find(
            (t) => t.name === tier.name || t.name === tier.id,
          );
          if (!sourceTier || sourceTier.type !== "IntervalTier")
            throw new BindingResolutionError(
              `Missing TextGrid tier: ${tier.name}`,
            );
          tiers[tier.id] = sourceTier.items
            .filter((i) => i.text.trim())
            .map((item, i) => ({ ...item, id: `source-t${index}-i${i}` }));
        }
        const seed = { tiers };
        if (validateTimelineAnswer(block.tiers, seed, false, false).length)
          throw new BindingResolutionError(
            "TextGrid does not match the timeline schema",
          );
        resolved.initialValue = seed;
        return resolved;
      }
      if (!["text", "transcript"].includes(block.type))
        throw new BindingResolutionError(
          "Text value requires a text/transcript block.",
        );
      const value =
        text({ ...binding, type: "string" }, binding.fallback) ?? "";
      if (binding.mode === "reference") {
        resolved.helpText = [
          resolved.helpText,
          `Reference (dataset question): ${value || "Unavailable"}`,
        ]
          .filter(Boolean)
          .join("\n");
      } else if (binding.mode === "read_only") {
        // Reuse a display-only block, so both the renderer and answer validator
        // forbid recording the context as if it were an independent response.
        resolved.type = "callout";
        resolved.required = false;
        resolved.description = value || "Source field unavailable";
      } else if (binding.mode === "prefill") {
        if (block.maxLength !== undefined && value.length > block.maxLength)
          throw new BindingResolutionError(
            "Prefill exceeds the text field's maximum length.",
          );
        resolved.initialValue = value;
      } else
        throw new BindingResolutionError("Unsupported value binding mode.");
    }
    return resolved;
  });
}

/** Resolve ordered sources independently; each panel keeps its own permitted IDs and text. */
export function resolveBoundBatchBlocks(
  blocks: Block[],
  sources: (WorkerSourcePayload | null)[],
): Block[] {
  return blocks.map((block) => {
    const count = block.numBatch ?? 1;
    if (
      count <= 1 ||
      [
        "ranking",
        "audio_comparison",
        "section",
        "callout",
        "transcript_summary",
        "candidate_vote",
      ].includes(block.type)
    )
      return resolveBoundBlocks([block], sources[0] ?? null)[0];
    if (
      !block.sourceBindings ||
      !Object.values(block.sourceBindings).some(Boolean)
    )
      return block;
    if (sources.length < count)
      throw new BindingResolutionError(
        `Select ${count} source recordings for this batch preview.`,
      );
    const batchBlocks = sources
      .slice(0, count)
      .map(
        (source) => resolveBoundBlocks([{ ...block, numBatch: 1 }], source)[0],
      );
    return { ...block, batchBlocks };
  });
}

/** Seed editable text once, only before the first revision. An existing empty draft wins. */
export function initialBoundAnswers(blocks: Block[]): Record<string, unknown> {
  const initial: Record<string, unknown> = {};
  for (const block of blocks) {
    if (block.batchBlocks) {
      const seeds = block.batchBlocks.map(
        (child) => initialBoundAnswers([child])[child.id] ?? null,
      );
      if (seeds.some((value) => value !== null)) initial[block.id] = seeds;
      continue;
    }
    if (
      ["text", "transcript", "timeline_annotation"].includes(block.type) &&
      block.sourceBindings?.value?.mode === "prefill" &&
      block.initialValue !== undefined
    )
      initial[block.id] = block.initialValue;
  }
  return initial;
}

/** Preserve saved edits (even an empty draft); seed public prefill only before revision 1. */
export function startingAssignmentAnswers(
  task: { initialAnswers?: Record<string, unknown> },
  current: { answers: Record<string, unknown> } | null,
): Record<string, unknown> {
  return current ? current.answers : { ...task.initialAnswers };
}

/** Resolve task-level instructions through the same public text-binding rules as
 * block context. Static instructions are the explicit use_default fallback only.
 */
export function resolveBoundInstructions(
  instructions: string,
  binding: DatasetTextBinding | undefined,
  source: SourceFieldPayload | WorkerSourcePayload | null,
): string {
  if (!binding) return instructions;
  return (
    resolveBoundBlocks(
      [
        {
          id: "instructions",
          type: "text",
          label: "Instructions",
          required: false,
          sourceBindings: {
            value: { ...binding, mode: "read_only", fallback: instructions },
          },
        },
      ],
      source,
    )[0].description ?? ""
  );
}
