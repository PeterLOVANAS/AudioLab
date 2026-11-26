import type {
  CandidateSetView,
  CandidateSelectionAnswer,
  CandidateValue,
} from "@/lib/contracts/candidate-sets";

/** Display only anonymous answer content; never use serialized private source objects. */
export function candidateText(value: CandidateValue): string {
  return Array.isArray(value)
    ? value.join(" → ")
    : typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : String(value);
}

/** Controlled UI action; the backend independently rechecks eligibility and snapshot identity. */
export function selectCandidate(
  set: CandidateSetView,
  id: string,
): CandidateSelectionAnswer {
  if (set.closed || !set.candidates.some((candidate) => candidate.id === id))
    throw new Error("This candidate is not available for selection.");
  return { candidateSetSnapshotId: set.id, selectedCandidateId: id };
}
