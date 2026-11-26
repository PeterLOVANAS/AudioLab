import type {
  ResultItem,
  ResultDistribution,
  ResultReference,
} from "@/lib/contracts/job-results";
import type { ResearchBlock } from "@/lib/contracts/research-export";
import { originalChoiceValue } from "@/lib/contracts/source-reference";
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const selection = (v: unknown) =>
  record(v) && "selection" in v ? v.selection : v;

/** Count validated final observations only. Audio slot IDs are scoped to this
 * Task Instance; display filenames never become ranking or choice identities.
 * Repeated children are passed in their worker-local entry scopes by the caller. */
export function resultDistribution(
  item: Pick<ResultItem, "block" | "observations" | "audio">,
): ResultDistribution {
  const { block, observations, audio } = item;
  const counts: ResultDistribution["counts"] = [];
  const ranks: ResultDistribution["ranks"] = [];
  const options = (v: unknown): Array<{ id: string; label: string }> =>
    Array.isArray(v)
      ? v.flatMap((o) =>
          record(o) && typeof o.id === "string" && typeof o.label === "string"
            ? [{ id: o.id, label: o.label }]
            : [],
        )
      : [];
  if (
    [
      "single_choice",
      "multiple_choice",
      "boolean",
      "audio_comparison",
    ].includes(block.type)
  ) {
    counts.push(
      ...(block.type === "boolean"
        ? [
            { id: "true", label: "Yes" },
            { id: "false", label: "No" },
          ]
        : options(block.options)
      ).map((o) => ({ ...o, count: 0 })),
    );
    for (const o of observations.filter((o) => o.state === "valid")) {
      const value = selection(o.value);
      for (const id of new Set(Array.isArray(value) ? value : [value])) {
        let row = counts.find((r) => r.id === String(id));
        if (!row && id === "__custom__" && record(o.value)) {
          // Custom answers remain a separate category, with readable raw text
          // available in the inspector rather than invented shared identities.
          row = { id, label: "Custom answer", count: 0 };
          counts.push(row);
        }
        if (row) row.count++;
      }
    }
  }
  if (block.type === "ranking") {
    const ids =
      block.rankingMode === "labels"
        ? options(block.rankLabels)
        : (Array.isArray(block.stimulusSlots) ? block.stimulusSlots : []).map(
            (_, i) => ({
              id: `slot-${i}`,
              label: `Audio ${i + 1}: ${audio[i]?.label ?? "unavailable"}`,
            }),
          );
    ranks.push(...ids.map((o) => ({ ...o, positions: ids.map(() => 0) })));
    for (const o of observations.filter((o) => o.state === "valid"))
      if (Array.isArray(o.value))
        o.value.forEach((id, position) => {
          const row = ranks.find((r) => r.id === id);
          if (row && position < ids.length) row.positions[position]++;
        });
  }
  return { counts, ranks };
}

/** Resolve an original imported choice answer against this question's canonical
 * IDs and labels. Ambiguity (including ID/label collisions) is unavailable;
 * option order or majority response is never used to guess a reference. */
export function referenceEvaluation(
  block: ResearchBlock,
  observations: ResultItem["observations"],
  payloads: unknown[],
): ResultReference {
  const base = {
    origin: "current-source" as const,
    available: false,
    reason: "No unambiguous original reference for this bound choice question.",
    observations: observations.map((o) => ({
      workerId: o.workerId,
      match: null as boolean | null,
    })),
  };
  if (
    !["single_choice", "multiple_choice"].includes(block.type) ||
    !record(block.sourceBindings) ||
    !block.sourceBindings.options ||
    payloads.length !== 1 ||
    !Array.isArray(block.options)
  )
    return base;
  const options = block.options.filter(record);
  const raw = originalChoiceValue(payloads[0]);
  const values =
    block.type === "multiple_choice" && Array.isArray(raw) ? raw : [raw];
  if (!values.length || values.some((v) => typeof v !== "string")) return base;
  const ids: string[] = [];
  for (const v of values) {
    const matches = options.filter((o) => o.id === v || o.label === v);
    if (matches.length !== 1 || typeof matches[0].id !== "string") return base;
    ids.push(matches[0].id);
  }
  if (
    new Set(ids).size !== ids.length ||
    (block.type === "single_choice" && ids.length !== 1)
  )
    return base;
  return {
    ...base,
    available: true,
    reason:
      "Exact match against the current imported original answer; not a pinned historical reference. Training previews are not blind evaluation.",
    observations: observations.map((o) => {
      const selected = selection(o.value),
        actual = Array.isArray(selected) ? selected : [selected];
      return {
        workerId: o.workerId,
        match:
          o.state !== "valid"
            ? null
            : actual.length === ids.length &&
              actual.every((v) => ids.includes(String(v))),
      };
    }),
  };
}
