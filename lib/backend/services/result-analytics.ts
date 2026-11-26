import type { ResearchBlock } from "@/lib/contracts/research-export";
import type {
  ResultItem,
  ResultObservation,
  ResultPair,
  TemporalEvent,
} from "@/lib/contracts/job-results";
import { readableBlockAnswer } from "@/lib/contracts/readable-answers";
import { validateTimelineAnswer } from "../validation/timeline-answers";
import { validateAnswers } from "../validation/annotation-answers";
import { compareBlock } from "./agreement";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

/** Validate without coercion/clipping. Missing tiers are unavailable rather than
 * explicit absence. Sorting/merging is derived computation only; raw values stay intact. */
export function temporalEvents(
  block: ResearchBlock,
  value: unknown,
  duration: number | null,
): TemporalEvent[] {
  if (!record(value) || !record(value.tiers) || !Array.isArray(block.tiers))
    throw Error("Missing timeline tiers");
  const errors = validateTimelineAnswer(
    block.tiers,
    value,
    block.required,
    true,
  );
  if (errors.length) throw Error(errors[0]);
  const events: TemporalEvent[] = [];
  for (const tier of block.tiers as Array<{ id: string }>) {
    const rows = value.tiers[tier.id];
    if (!Array.isArray(rows))
      throw Error("Missing tier is not explicit absence");
    for (const row of rows as Array<{
      start: number;
      end: number;
      text: string;
    }>) {
      if (duration !== null && row.end > duration)
        throw Error("Interval exceeds recording duration");
      events.push({
        start: row.start,
        end: row.end,
        label: row.text,
        tierId: tier.id,
      });
    }
  }
  return events;
}
/** Union intervals independently within each exact tier/event-label identity.
 * Interval IDs, speaker names and input order are not event identities. */
function regions(events: TemporalEvent[]) {
  const grouped = new Map<string, Array<{ start: number; end: number }>>();
  for (const event of events) {
    if (
      !Number.isFinite(event.start) ||
      !Number.isFinite(event.end) ||
      event.start < 0 ||
      event.end <= event.start
    )
      throw Error("Invalid interval");
    const key = JSON.stringify([event.tierId, event.label]);
    let rows = grouped.get(key);
    if (!rows) {
      rows = [];
      grouped.set(key, rows);
    }
    rows.push({ start: event.start, end: event.end });
  }
  for (const [key, rows] of grouped) {
    rows.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: typeof rows = [];
    for (const row of rows) {
      const last = merged.at(-1);
      if (last && row.start <= last.end) last.end = Math.max(last.end, row.end);
      else merged.push({ ...row });
    }
    grouped.set(key, merged);
  }
  return grouped;
}
/** Labelled interval-set IoU in seconds. Intersections occur only within an exact
 * label+tier identity. Durations sum across these disjoint identity spaces.
 * Empty/empty is absence agreement, excluded from temporal localization IoU. */
export function intervalSetIoU(
  left: TemporalEvent[],
  right: TemporalEvent[],
): number | null {
  const a = regions(left),
    b = regions(right);
  let intersection = 0,
    total = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key) ?? [],
      y = b.get(key) ?? [];
    total += [...x, ...y].reduce((s, v) => s + v.end - v.start, 0);
    let i = 0,
      j = 0;
    while (i < x.length && j < y.length) {
      intersection += Math.max(
        0,
        Math.min(x[i].end, y[j].end) - Math.max(x[i].start, y[j].start),
      );
      if (x[i].end < y[j].end) i++;
      else j++;
    }
  }
  const union = total - intersection;
  return union ? intersection / union : null;
}
/** Metrics are descriptive inter-annotator comparisons, never reference accuracy. */
export function metricName(type: string): string {
  return type === "timeline_annotation"
    ? "interval-set temporal IoU"
    : type === "multiple_choice"
      ? "Jaccard"
      : type === "ranking"
        ? "ordering agreement"
        : type === "audio_comparison"
          ? "per-comparison exact agreement"
          : ["text", "transcript"].includes(type)
            ? "normalized text similarity"
            : ["number", "rating_scale"].includes(type)
              ? "inter-annotator agreement (undefined for numeric scales)"
              : ["single_choice", "boolean"].includes(type)
                ? "exact agreement"
                : "Unavailable — no defined comparison metric";
}
/** Validate one resolved answer independent of required/conditional form state.
 * Missing values remain missing; submitted explicit empty intervals stay distinguishable.
 * Candidate provenance is displayed but not inferred from today's source records. */
export function observation(
  block: ResearchBlock,
  value: unknown,
  source: Omit<ResultObservation, "value" | "readable" | "state" | "reason">,
  submitted: boolean,
  audio: ResultItem["audio"],
): ResultObservation {
  const base = {
    ...source,
    value: value ?? null,
    readable:
      value === undefined
        ? null
        : readableBlockAnswer(
            block,
            value,
            audio.map((a) => a.label),
          ),
  };
  if (!submitted || !source.revisionId)
    return { ...base, state: "unsubmitted", reason: "No submitted revision" };
  if (value === undefined || value === null)
    return {
      ...base,
      state: "missing",
      reason: "No submitted value for this block",
    };
  try {
    if (block.type === "timeline_annotation") {
      const events = temporalEvents(block, value, audio[0]?.duration ?? null);
      return { ...base, state: events.length ? "valid" : "empty" };
    }
    if (block.type === "candidate_vote") {
      if (!record(value)) throw Error("Invalid persisted candidate answer");
      if (block.candidateSource === "set") {
        if (
          typeof value.candidateSetSnapshotId !== "string" ||
          typeof value.selectedCandidateId !== "string"
        )
          throw Error("Missing candidate set provenance");
      } else if (
        typeof value.value !== "string" ||
        (block.candidateSource !== "example" &&
          typeof value.candidateId !== "string")
      )
        throw Error("Missing curated candidate provenance");
    } else {
      // Reuse actual runtime answer validation, clearing form-level conditions.
      const { showWhen: _, ...plain } = block;
      const errors = validateAnswers(
        {
          id: "analytics",
          version: 1,
          name: "Analytics",
          description: "",
          domain: "general",
          instructions: "",
          policy: {
            requiredIndependentVotes: 1,
            blindToOthers: true,
            requiresReview: false,
          },
          blocks: [{ ...plain, required: false, numBatch: 1 }],
        },
        { [block.id]: value },
        false,
        { audioAssetCount: audio.length },
      );
      if (errors.length) throw Error(errors[0].message);
    }
    return { ...base, state: "valid" };
  } catch (error) {
    return {
      ...base,
      state: "invalid",
      reason:
        error instanceof Error ? error.message : "Invalid persisted answer",
    };
  }
}
/** Compare every unordered independent worker pair within one pinned task,
 * resolved block/path and audio slot. The caller isolates worker-local manual
 * group entries; missing peers are excluded, never aligned by list position. */
export function analyzeItem(
  input: Omit<
    ResultItem,
    | "tracks"
    | "pairs"
    | "mean"
    | "min"
    | "max"
    | "validObservations"
    | "excludedObservations"
    | "eligiblePairs"
    | "excludedPairs"
    | "absencePairs"
    | "metric"
    | "numeric"
  >,
): ResultItem {
  const tracks: ResultItem["tracks"] = [];
  if (input.block.type === "timeline_annotation")
    input.observations.forEach((o, index) => {
      if (o.state === "valid" || o.state === "empty")
        tracks.push({
          observation: index,
          events: temporalEvents(
            input.block,
            o.value,
            input.audio[0]?.duration ?? null,
          ),
        });
    });
  const pairs: ResultPair[] = [];
  for (let i = 0; i < input.observations.length; i++)
    for (let j = i + 1; j < input.observations.length; j++) {
      const a = input.observations[i],
        b = input.observations[j];
      let score: number | null = null,
        reason: string | undefined,
        absenceAgreement = false;
      if (
        !["valid", "empty"].includes(a.state) ||
        !["valid", "empty"].includes(b.state)
      )
        reason = "Missing, invalid or unsubmitted observation";
      else if (a.workerId === b.workerId || a.revisionId === b.revisionId)
        reason = "Independent revisions required";
      else
        try {
          if (input.block.type === "timeline_annotation") {
            score = intervalSetIoU(
              tracks.find((t) => t.observation === i)!.events,
              tracks.find((t) => t.observation === j)!.events,
            );
            if (score === null) {
              reason = "Both explicitly empty: absence agreement";
              absenceAgreement = true;
            }
          } else if (
            [
              "number",
              "rating_scale",
              "candidate_vote",
              "repeated_group",
            ].includes(input.block.type)
          )
            reason = "No defined inter-annotator metric for this block";
          else {
            const plain = (v: unknown) =>
              record(v) && "selection" in v ? v.selection : v;
            if (
              [a.value, b.value].some(
                (v) => record(v) && v.customText !== undefined,
              )
            )
              throw Error("Custom options have no canonical shared identity");
            score = compareBlock(
              input.block,
              plain(a.value),
              plain(b.value),
            ).similarity;
          }
        } catch (error) {
          reason =
            error instanceof Error ? error.message : "Unavailable comparison";
        }
      pairs.push({
        left: i,
        right: j,
        score,
        ...(reason ? { reason } : {}),
        ...(absenceAgreement ? { absenceAgreement } : {}),
      });
    }
  const scores = pairs.flatMap((p) => (p.score === null ? [] : [p.score]));
  const values = input.observations
    .filter((o) => o.state === "valid")
    .map((o) => o.value)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return {
    ...input,
    tracks,
    pairs,
    mean: mean(scores),
    min: scores.length ? Math.min(...scores) : null,
    max: scores.length ? Math.max(...scores) : null,
    validObservations: input.observations.filter((o) =>
      ["valid", "empty"].includes(o.state),
    ).length,
    excludedObservations: input.observations.filter(
      (o) => !["valid", "empty"].includes(o.state),
    ).length,
    eligiblePairs: scores.length,
    excludedPairs: pairs.length - scores.length,
    absencePairs: pairs.filter((p) => p.absenceAgreement).length,
    metric: metricName(input.block.type),
    numeric:
      ["number", "rating_scale"].includes(input.block.type) && values.length
        ? {
            count: values.length,
            mean: mean(values)!,
            min: Math.min(...values),
            max: Math.max(...values),
          }
        : null,
  };
}
