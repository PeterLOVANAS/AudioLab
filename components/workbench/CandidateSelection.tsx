"use client";
import { useId } from "react";
import type {
  CandidateSelectionAnswer,
  CandidateSetView,
} from "@/lib/contracts/candidate-sets";
import {
  candidateText,
  selectCandidate,
} from "@/lib/frontend/candidate-voting";

/**
 * Controlled selection over the owner's server-projected candidates. The parent
 * owns draft/submit state, so reopening restores exactly the stored set/entry IDs.
 * Merely rendering never records a vote. No actors, counts or winner are displayed.
 */
export default function CandidateSelection({
  set,
  value,
  onChange,
}: {
  set?: CandidateSetView;
  value: unknown;
  onChange: (next: CandidateSelectionAnswer | undefined) => void;
}) {
  const name = useId();
  if (!set)
    return (
      <p role="status">
        Candidates are not ready. Ask the project admin to prepare this voting
        job.
      </p>
    );
  if (!set.candidates.length)
    return (
      <p role="status">
        No eligible candidates are available for your assignment.
      </p>
    );
  const vote =
    value && typeof value === "object"
      ? (value as Partial<CandidateSelectionAnswer>)
      : {};
  const selected =
    vote.candidateSetSnapshotId === set.id
      ? vote.selectedCandidateId
      : undefined;
  return (
    <div>
      {set.closed && (
        <p role="status">Voting is complete. This candidate set is closed.</p>
      )}
      <div role="radiogroup" aria-label="Candidate annotations">
        {set.candidates.map((candidate, index) => (
          <label className="tb-choice" key={candidate.id}>
            <input
              type="radio"
              name={name}
              value={candidate.id}
              checked={selected === candidate.id}
              disabled={set.closed}
              onChange={() => onChange(selectCandidate(set, candidate.id))}
            />
            <span>
              <strong>Candidate {index + 1}</strong>
              <span style={{ display: "block", whiteSpace: "pre-wrap" }}>
                {candidateText(candidate.value)}
              </span>
            </span>
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={set.closed || !selected}
        onClick={() => onChange(undefined)}
      >
        Clear selection
      </button>
    </div>
  );
}
