/**
 * Publication capabilities shared by the Builder and the publish service.
 *
 * This conservative list preserves existing Builder gates. Supporting a type
 * here means its assigned-workspace answer contract is enabled for publication;
 * it does not replace definition validation or per-answer validation. Audio
 * Comparison uses ordered batches and one stable option ID per comparison group;
 * summary publication remains gated pending its separate integration work.
 */
const publishableTypes = new Set([
  "single_choice",
  "multiple_choice",
  "boolean",
  "number",
  "rating_scale",
  "repeated_group",
  "text",
  "transcript",
  "timeline_annotation",
  "candidate_vote",
  "ranking",
  "audio_comparison",
  "section",
  "callout",
  "audio_player",
]);

/** Return whether this block kind has an enabled publication/answer pipeline. */
export function canPublishBlockType(type: string): boolean {
  return publishableTypes.has(type);
}
