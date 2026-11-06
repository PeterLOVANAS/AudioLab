// The catalogue comes from main. Choice options use the ID spelling required by its HTTP API.
import type {
  AnnotationBlock,
  AnnotationPolicy,
  AnnotationScope,
  AudioWorkspaceConfig,
  BlockCondition,
  TaskDomain,
  TimelineTier,
} from "@/lib/contracts/tasks";

type Kind = AnnotationBlock["type"];
export type EditableKind = Exclude<Kind, "continuous_rating">;
export type AnswerAppearance = "cards" | "compact" | "bullets";
// Descriptions belong to individual answers. Other styles keep this text saved
// so switching back to large cards brings it back without retyping it.
export type Option = { id: string; label: string; value?: string; description?: string };
export type Block = {
  id: string;
  type: Kind;
  label: string;
  helpText?: string;
  required: boolean;
  scope?: AnnotationScope;
  showWhen?: BlockCondition;
  options?: Option[];
  // Stored on this question, not the whole task. The existing draft save API
  // preserves extra block fields, so this also travels into published versions.
  // Optional so existing definitions retain the original bullet controls.
  answerAppearance?: AnswerAppearance;
  minSelections?: number;
  maxSelections?: number;
  requiredValue?: boolean;
  min?: number;
  max?: number;
  integerOnly?: boolean;
  unit?: string;
  step?: number;
  minLabel?: string;
  maxLabel?: string;
  multiline?: boolean;
  placeholder?: string;
  maxLength?: number;
  language?: string;
  notation?: "orthographic" | "ipa";
  allowCorrection?: boolean;
  stimulusSlots?: string[];
  randomizeOrder?: boolean;
  allowTies?: boolean;
  // A presentational block draws a section/callout but stores no human answer.
  description?: string;
  tone?: "neutral" | "success" | "warning" | "info";
  // Audio Player refers to a slot of the *task instance*, not a WAV path in definition.
  stimulusSlot?: string;
  showWaveform?: boolean;
  sourceTimelineBlockId?: string;
  summaryMode?: "words" | "phones" | "both";
  // Timeline tier definitions are saved as metadata, whereas the recorded
  // intervals live in annotation revisions as answers[block.id].
  tiers?: TimelineTier[];
  alphabet?: "IPA" | "SAMPA" | "X-SAMPA" | "ARPABET";
  transcriptionLevel?: "phonemic" | "broad" | "narrow";
  itemLabel?: string;
  minItems?: number;
  maxItems?: number;
  blocks?: Block[];
};
export type Draft = {
  name: string;
  description: string;
  domain: TaskDomain;
  instructions: string;
  policy: AnnotationPolicy;
  blocks: Block[];
  workspace?: AudioWorkspaceConfig;
};
export const catalog = {
  single_choice: ["Single choice", "Pick one answer", "01"],
  multiple_choice: ["Multiple choice", "Select several answers", "02"],
  boolean: ["Yes / No", "Confirm a statement", "03"],
  number: ["Number", "Count or measure", "04"],
  rating_scale: ["Rating scale", "Score on a scale", "05"],
  text: ["Text box", "Write a short or long answer", "06"],
  transcript: ["Transcript", "Transcribe untimed speech", "07"],
  candidate_vote: ["Candidate vote", "Review a suggested label", "08"],
  audio_comparison: ["Audio comparison", "Compare recording slots", "09"],
  ranking: ["Ranking", "Order recordings", "10"],
  repeated_group: ["Repeated group", "Repeat a set of questions", "11"],
  section: ["Section heading", "Organize questions without saving an answer", "12"],
  callout: ["Information / confirmation panel", "Colored instructions shown conditionally", "13"],
  audio_player: ["Audio player", "Display the assigned audio or a comparison slot", "14"],
  timeline_annotation: ["Phonetic / sound grounding", "Editable word and phone tiers, IPA, TextGrid", "15"],
  transcript_summary: ["Word / phone summary", "Live display of the grounding block's labels", "16"],
} satisfies Record<EditableKind, [string, string, string]>;
export const kinds = Object.keys(catalog) as EditableKind[];
export function editable(kind: Kind): kind is EditableKind {
  return Object.hasOwn(catalog, kind);
}
export function title(kind: Kind) {
  return editable(kind) ? catalog[kind][0] : "Grounding workspace";
}
export function canSubmit(kind: Kind) {
  return ["single_choice", "multiple_choice", "boolean", "number", "rating_scale", "text", "transcript", "timeline_annotation", "section", "callout", "audio_player", "transcript_summary"].includes(
    kind,
  );
}
// The current answer API enforces only these six types and a subset of their optional rules.
export function publishLimit(block: Block): string | undefined {
  if (!canSubmit(block.type)) return title(block.type) + " answers";
}
export const blankDraft = (): Draft => ({
  name: "",
  description: "",
  instructions: "",
  domain: "sound",
  blocks: [],
  policy: { requiredIndependentVotes: 1, blindToOthers: true, requiresReview: false },
});
export function newBlock(type: EditableKind): Block {
  const block: Block = { id: crypto.randomUUID(), type, label: title(type), required: true };
  if (["single_choice", "multiple_choice", "audio_comparison"].includes(type)) {
    block.options = ["Option A", "Option B"].map((label) => ({ id: crypto.randomUUID(), label }));
  }
  if (type === "text") block.multiline = true;
  if (type === "transcript") block.notation = "orthographic";
  if (type === "rating_scale") Object.assign(block, { min: 1, max: 5, step: 1 });
  if (type === "ranking" || type === "audio_comparison") block.stimulusSlots = ["Audio A", "Audio B"];
  if (type === "ranking") block.allowTies = false;
  if (type === "section") Object.assign(block, { required: false, description: "Describe what comes next.", tone: "neutral" });
  if (type === "callout") Object.assign(block, { required: false, description: "Read this before continuing.", tone: "info" });
  if (type === "audio_player") Object.assign(block, { required: false, showWaveform: true });
  if (type === "transcript_summary") Object.assign(block, {
    required: false, sourceTimelineBlockId: "", summaryMode: "both",
  });
  if (type === "timeline_annotation") Object.assign(block, {
    alphabet: "IPA", transcriptionLevel: "broad",
    tiers: [
      { id: "words", name: "Words", labelMode: "text", kind: "interval", allowOverlap: true },
      { id: "phones", name: "Phones", labelMode: "ipa", kind: "interval", allowOverlap: true, parentTierId: "words" },
    ],
  });
  if (type === "repeated_group")
    Object.assign(block, { itemLabel: "Speaker", blocks: [newBlock("text")] });
  return block;
}
export function exampleDraft(): Draft {
  const presence = newBlock("single_choice");
  presence.label = "Can you hear a bird?";
  presence.options = ["Present", "Absent", "Unsure"].map((label) => ({
    id: label.toLowerCase(),
    label,
  }));
  const other = newBlock("multiple_choice");
  other.label = "Which other sounds do you hear?";
  other.required = false;
  other.options = ["Rain", "Traffic", "Voices"].map((label) => ({ id: label.toLowerCase(), label }));
  const confirmation = newBlock("boolean");
  confirmation.label = "I listened to the complete clip and confirm this sound is absent.";
  confirmation.requiredValue = true;
  confirmation.showWhen = { blockId: presence.id, equals: "absent" };
  const panel = newBlock("callout");
  panel.label = "Absence verification";
  panel.description = "Please listen all the way through before confirming absence.";
  panel.tone = "success";
  panel.showWhen = { blockId: presence.id, equals: "absent" };
  const intro = newBlock("section");
  intro.label = "Listening and presence";
  intro.description = "Please answer according to the recording, not the reference caption.";
  const notes = newBlock("text");
  notes.label = "What made you unsure?";
  notes.required = false;
  notes.helpText = "Describe what masked the sound.";
  notes.showWhen = { blockId: presence.id, equals: "unsure" };
  return {
    ...blankDraft(),
    name: "Bird-call check",
    instructions: "Listen to the whole clip once before answering.",
    blocks: [intro, presence, panel, confirmation, other, notes],
  };
}
// Older drafts may use the names from tasks.ts. Keep other properties, including teammate-owned data.
export function readBlock(block: Block & { showwhen?: BlockCondition }): Block {
  if (!editable(block.type)) return block;
  const { showwhen, ...copy } = block;
  if (showwhen && !copy.showWhen) copy.showWhen = showwhen;
  if (Array.isArray(block.options))
    copy.options = block.options.map((option) => ({
      ...option,
      id: option.id ?? option.value ?? "",
      label: option.label ?? "",
    }));
  if (Array.isArray(block.blocks)) copy.blocks = block.blocks.map(readBlock);
  return copy;
}
export function moveBlock(blocks: Block[], index: number, offset: number) {
  const copy = [...blocks];
  const target = index + offset;
  if (target < 0 || target >= copy.length) return blocks;
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}
export function hasChoiceOptions(type: Kind) {
  return ["single_choice", "multiple_choice", "audio_comparison"].includes(type);
}
export function conditionSources(blocks: Block[]) {
  return blocks.filter((block) =>
    ["single_choice", "boolean", "number", "rating_scale", "text"].includes(block.type),
  );
}
export function checkBlocks(blocks: Block[], parent = ""): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  blocks.forEach((block, index) => {
    const where = parent + (index + 1);
    const report = (message: string) => errors.push("Block " + where + " · " + message);
    if (!block.id || seen.has(block.id)) report("Each block needs its own ID.");
    seen.add(block.id);
    if (!block.label.trim()) report("Enter a block label.");
    if (["section", "callout", "audio_player", "transcript_summary"].includes(block.type) && block.required)
      report("Display-only blocks cannot require an answer.");
    if (["section", "callout"].includes(block.type) &&
        ![undefined, "neutral", "success", "warning", "info"].includes(block.tone))
      report("Choose a valid panel tone.");
    if (block.type === "transcript_summary" && !blocks.slice(0,index).some(
      earlier => earlier.type === "timeline_annotation" && earlier.id === block.sourceTimelineBlockId))
      report("Choose an earlier Grounding block to summarize.");
    if (block.type === "timeline_annotation") {
      const tiers = block.tiers ?? [];
      const ids = tiers.map(t => t.id);
      if (!tiers.length || tiers.length > 10 || new Set(ids).size !== ids.length ||
          tiers.some(t => !t.id || !t.name.trim() || t.kind !== "interval"))
        report("Define 1–10 uniquely named interval tiers.");
      if (tiers.some(t => t.parentTierId && !ids.includes(t.parentTierId)))
        report("Each parent tier must exist in this grounding block.");
    }
    const rule = block.showWhen;
    if (rule) {
      const source = conditionSources(blocks.slice(0, index)).find(
        (previous) => previous.id === rule.blockId,
      );
      if (!source) report("Choose an earlier question for the visibility rule.");
      else if (["number", "rating_scale"].includes(source.type) && !Number.isFinite(rule.equals))
        report("Enter a number for the visibility rule.");
      else if (source.type === "boolean" && typeof rule.equals !== "boolean")
        report("Choose Yes or No for the visibility rule.");
      else if (
        source.type === "single_choice" &&
        !source.options?.some((option) => option.id === rule.equals)
      )
        report("Choose an existing answer for the visibility rule.");
    }
    if (hasChoiceOptions(block.type)) {
      const options = block.options ?? [];
      if (
        options.length < 2 ||
        options.some((option) => !option.id || !option.label.trim()) ||
        new Set(options.map((option) => option.id)).size !== options.length
      ) {
        report("Add at least two named choices with distinct IDs.");
      }
    }
    function limits(min: number | undefined, max: number | undefined, counts = false) {
      if (min !== undefined && max !== undefined && min > max)
        report("Minimum must be at or below maximum.");
      if (
        counts &&
        [min, max].some((value) => value !== undefined && (!Number.isInteger(value) || value < 0))
      )
        report("Counts must be whole numbers at or above zero.");
    }
    if (block.type === "number" || block.type === "rating_scale") limits(block.min, block.max);
    if (
      block.type === "rating_scale" &&
      (![block.min, block.max, block.step].every(Number.isInteger) ||
        (block.step ?? 0) < 1 ||
        block.min === block.max)
    )
      report("Use whole-number limits and a positive whole step for this scale.");
    if (block.type === "multiple_choice") {
      limits(block.minSelections, block.maxSelections, true);
      if (
        [block.minSelections, block.maxSelections].some(
          (limit) => limit !== undefined && limit > (block.options?.length ?? 0),
        )
      )
        report("Selection limits cannot exceed the number of choices.");
      if (block.required && block.maxSelections === 0)
        report("A required question needs at least one selection.");
    }
    if (
      block.type === "text" &&
      block.maxLength !== undefined &&
      (!Number.isInteger(block.maxLength) || block.maxLength < 1 || block.maxLength > 20000)
    )
      report("Text limit must be 1–20,000 characters.");
    if (block.type === "ranking" || block.type === "audio_comparison") {
      const slots = block.stimulusSlots ?? [];
      if (
        slots.length < 2 ||
        slots.some((slot) => !slot.trim()) ||
        new Set(slots.map((slot) => slot.trim())).size !== slots.length
      )
        report("Give at least two audio slots distinct names.");
    }
    if (block.type === "repeated_group") {
      limits(block.minItems, block.maxItems, true);
      if (!block.itemLabel?.trim() || !block.blocks?.length)
        report("Name the repeated item and add a question inside it.");
      if (block.required && block.maxItems === 0) report("A required group must allow an item.");
      if (block.blocks?.some((child) => child.type === "repeated_group"))
        report("Groups cannot contain another group.");
      errors.push(...checkBlocks(block.blocks ?? [], where + "."));
    }
  });
  return errors;
}
export function checkDraft(draft: Draft): string[] {
  const errors = checkBlocks(draft.blocks);
  if (!draft.name.trim()) errors.unshift("Enter a task name.");
  if (!draft.instructions.trim()) errors.push("Add instructions for the labeller.");
  if (!draft.blocks.length || draft.blocks.length > 100)
    errors.push("Add between 1 and 100 top-level blocks.");
  if (
    !Number.isInteger(draft.policy.requiredIndependentVotes) ||
    draft.policy.requiredIndependentVotes < 1 ||
    draft.policy.requiredIndependentVotes > 20
  )
    errors.push("Choose 1–20 independent votes.");
  return errors;
}
