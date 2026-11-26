import type { ResearchBlock } from "./research-export";
const perAudio = new Set([
  "single_choice",
  "multiple_choice",
  "boolean",
  "number",
  "rating_scale",
  "text",
  "transcript",
  "timeline_annotation",
]);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.flatMap((value) => (record(value) ? [record(value)!] : []))
    : [];

/** Human-readable projection of a submitted answer using its pinned resolved
 * block, never today's dataset or draft. Raw answers/IDs remain authoritative.
 * Output is additive export/display data, not a value accepted by submission APIs.
 * Missing/unknown historical labels are explicit rather than guessed.
 */
export function readableBlockAnswer(
  block: ResearchBlock,
  value: unknown,
  audioLabels: string[] = [],
): unknown {
  if (value === undefined || value === null) return null;
  const count = typeof block.numBatch === "number" ? block.numBatch : 1;
  if (count > 1 && perAudio.has(block.type) && Array.isArray(value))
    return value.map((entry, index) => ({
      recording: audioLabels[index] ?? `Audio ${index + 1}`,
      answer: readableBlockAnswer(
        Array.isArray(block.batchBlocks)
          ? (block.batchBlocks[index] as ResearchBlock)
          : { ...block, numBatch: 1 },
        entry,
        [audioLabels[index]],
      ),
    }));
  const optionLabel = (id: unknown) =>
    id === "__custom__"
      ? (record(value)?.customText ?? "Custom answer")
      : (rows(block.options).find((option) => option.id === id)?.label ??
        "Unknown option (label unavailable)");
  if (block.type === "single_choice" || block.type === "multiple_choice") {
    const wrapped = record(value),
      selected = wrapped?.selection ?? value;
    const label =
      selected === "__custom__"
        ? (wrapped?.customText ?? "Custom answer")
        : Array.isArray(selected)
          ? selected.map(optionLabel)
          : optionLabel(selected);
    if (wrapped?.children) {
      const children = record(wrapped.children) ?? {},
        followUps = (Array.isArray(selected) ? selected : [selected]).flatMap(
          (id) => rows(record(block.optionFollowUps)?.[String(id)]),
        );
      return {
        answer: label,
        followUps: rows(followUps)
          .filter((child) => Object.hasOwn(children, String(child.id)))
          .map((child) => ({
            question: child.label,
            answer: readableBlockAnswer(
              child as ResearchBlock,
              children[String(child.id)],
              audioLabels,
            ),
          })),
      };
    }
    return label;
  }
  if (block.type === "boolean")
    return value === true
      ? "Yes"
      : value === false
        ? "No"
        : "Invalid Boolean answer";
  if (block.type === "ranking" && Array.isArray(value))
    return value.map((id) => {
      if (block.rankingMode === "labels")
        return (
          rows(block.rankLabels).find((option) => option.id === id)?.label ??
          "Unknown ranked label"
        );
      const match = typeof id === "string" ? /^slot-(\d+)$/.exec(id) : null,
        index = match ? Number(match[1]) : -1;
      return index >= 0
        ? (audioLabels[index] ??
            (Array.isArray(block.stimulusSlots)
              ? block.stimulusSlots[index]
              : undefined) ??
            `Audio ${index + 1}`)
        : "Unknown ranked recording";
    });
  if (block.type === "audio_comparison" && Array.isArray(value)) {
    const size =
      typeof block.comparisonSize === "number" ? block.comparisonSize : 2;
    return value.map((id, index) => ({
      comparison: index + 1,
      recordings: Array.from(
        { length: size },
        (_, slot) =>
          audioLabels[index * size + slot] ??
          `Audio ${index * size + slot + 1}`,
      ),
      answer: optionLabel(id),
    }));
  }
  if (block.type === "repeated_group" && Array.isArray(value))
    return value.map((entry, index) => {
      const answers = record(record(entry)?.answers) ?? {};
      return {
        entry: index + 1,
        answers: rows(block.blocks)
          .filter((child) => Object.hasOwn(answers, String(child.id)))
          .map((child) => ({
            question: child.label,
            answer: readableBlockAnswer(
              child as ResearchBlock,
              answers[String(child.id)],
              audioLabels,
            ),
          })),
      };
    });
  if (block.type === "timeline_annotation") {
    const tiers = record(record(value)?.tiers) ?? {};
    return Object.entries(tiers).map(([id, segments]) => ({
      tier:
        rows(block.tiers).find((tier) => tier.id === id)?.name ??
        "Annotation tier",
      segments: rows(segments).map((segment) => ({
        start: segment.start,
        end: segment.end,
        label: segment.text,
        ...(segment.speaker ? { speaker: segment.speaker } : {}),
      })),
    }));
  }
  return value;
}
/** Label each answered block while preserving stable block IDs as lookup keys. */
export function readableTaskAnswers(
  blocks: ResearchBlock[],
  answers: Record<string, unknown>,
  audioLabels: string[] = [],
) {
  return Object.fromEntries(
    blocks
      .filter((block) => Object.hasOwn(answers, block.id))
      .map((block) => [
        block.id,
        {
          label: block.label,
          type: block.type,
          value: readableBlockAnswer(block, answers[block.id], audioLabels),
        },
      ]),
  );
}
