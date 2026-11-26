/**
 * Runtime semantics for a timeline_annotation answer.
 *
 * The browser is NOT trusted: labellers can hand-edit HTTP JSON. We therefore
 * check tier membership, IDs, timestamps, label types, overlaps and optional
 * links before writing any human-provided intervals to D1.
 *
 * Value shape (one value stored under answers[block.id]):
 *   { tiers: { words: [{id, start, end, text, speaker?, parentId?}], phones: [...] } }
 *
 * Times are seconds, never canvas pixels. `parentId` links a phone to a word
 * *semantically*, and intentionally does NOT constrain the phone's timing.
 * The frontend uses decoded audio duration to constrain edits; the backend
 * cannot reliably infer that duration from the published definition alone.
 * It sets a conservative 24-hour upper bound, pending asset-duration checks.
 */

type TierConfig = {
  id: string;
  name?: string;
  kind?: string;
  allowOverlap?: boolean;
  parentTierId?: string;
};
export type TimelineIssue = string;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function validateTimelineAnswer(
  rawTiers: unknown,
  value: unknown,
  required: boolean,
  submitting: boolean,
): TimelineIssue[] {
  const errors: string[] = [];
  if (!Array.isArray(rawTiers) || !rawTiers.length)
    return ["Timeline has no valid tier configuration."];
  if (!record(value) || !record(value.tiers))
    return ["Timeline answer needs a 'tiers' object."];
  const config = rawTiers as TierConfig[];
  const permitted = new Set(config.map((t) => t.id));
  const provided = value.tiers;
  for (const key of Object.keys(provided))
    if (!permitted.has(key)) errors.push(`Unknown timeline tier '${key}'.`);

  // Keep IDs unique across the entire block; links must be unambiguous.
  const allIds = new Set<string>();
  const byTier = new Map<string, Set<string>>();
  let total = 0;
  for (const tier of config) {
    const rows = provided[tier.id] ?? [];
    if (!Array.isArray(rows)) {
      errors.push(`Tier '${tier.id}' must be an array.`);
      continue;
    }
    if (rows.length > 5000) {
      errors.push(`Tier '${tier.id}' exceeds 5000 intervals.`);
      continue;
    }
    total += rows.length;
    const ids = new Set<string>();
    const intervals: Array<{ start: number; end: number }> = [];
    for (const [index, row] of rows.entries()) {
      const label = `${tier.id}[${index}]`;
      if (!record(row)) {
        errors.push(`${label} must be an object.`);
        continue;
      }
      const { id, start, end, text, speaker, parentId } = row;
      if (typeof id !== "string" || !id || id.length > 80 || allIds.has(id))
        errors.push(`${label} requires an ID unique across all tiers.`);
      else {
        allIds.add(id);
        ids.add(id);
      }
      if (
        typeof start !== "number" ||
        !Number.isFinite(start) ||
        start < 0 ||
        start > 86400 ||
        typeof end !== "number" ||
        !Number.isFinite(end) ||
        end <= start ||
        end > 86400
      )
        errors.push(`${label} requires 0 <= start < end <= 86400 seconds.`);
      else intervals.push({ start, end });
      if (typeof text !== "string" || !text.trim() || text.length > 2000)
        errors.push(
          `${label} needs a nonempty label of at most 2000 characters.`,
        );
      if (
        speaker !== undefined &&
        (typeof speaker !== "string" || speaker.length > 100)
      )
        errors.push(`${label} has invalid speaker metadata.`);
      if (
        parentId !== undefined &&
        parentId !== null &&
        typeof parentId !== "string"
      )
        errors.push(`${label} has an invalid parent link.`);
      for (const key of Object.keys(row))
        if (
          !["id", "start", "end", "text", "speaker", "parentId"].includes(key)
        )
          errors.push(`${label} has unknown field '${key}'.`);
    }
    byTier.set(tier.id, ids);
    if (tier.allowOverlap === false) {
      intervals.sort((a, b) => a.start - b.start || a.end - b.end);
      for (let i = 1; i < intervals.length; i++)
        if (intervals[i].start < intervals[i - 1].end - 1e-7)
          errors.push(
            `Tier '${tier.id}' cannot contain overlapping intervals.`,
          );
    }
  }
  // Validate semantic links after we have seen ALL segment IDs.
  for (const tier of config) {
    if (!tier.parentTierId) continue;
    const rows = provided[tier.id];
    if (!Array.isArray(rows)) continue;
    const parentIds = byTier.get(tier.parentTierId) ?? new Set<string>();
    for (const row of rows) {
      if (
        record(row) &&
        typeof row.parentId === "string" &&
        !parentIds.has(row.parentId)
      )
        errors.push(`Tier '${tier.id}' links to a missing parent interval.`);
    }
  }
  if (submitting && required && total === 0)
    errors.push("Add at least one labelled interval.");
  return errors;
}
