/** Answer content only; arbitrary metadata objects are never forwarded to blind voters. */
export type CandidateValue = string | number | boolean | string[];

/** Existing stored sources, not client-authored candidate text. */
export type CandidateSourceReference =
  | { kind: "dataset_annotation"; labelId: string; field?: "value" | "text" | "transcript" | "label" | "sound_label" }
  | { kind: "submission"; revisionId: string; blockId: string }
  | { kind: "curated"; candidateId: string };

/** Public per-assignment projection. Source actors/IDs remain in private provenance. */
export type CandidateSetView = {
  id: string;
  taskInstanceId: string;
  blockId: string;
  /** No tally/winner is disclosed to blind workers. */
  closed?: boolean;
  candidates: Array<{ id: string; value: CandidateValue }>;
};

/** The normal annotation write envelope stores this under its candidate_vote block ID. */
export type CandidateSelectionAnswer = {
  candidateSetSnapshotId: string;
  selectedCandidateId: string;
};

/** Server-only validator context, already filtered for assignment/self-vote eligibility. */
export type CandidateSelectionContext = Record<string, { id: string; candidateIds: string[] }>;

/** Published source categories; source IDs are selected per job, never embedded in templates. */
export type CandidateOrigin = CandidateSourceReference["kind"];
export type CandidateSourceOption = {
  source: CandidateSourceReference;
  value: CandidateValue
  label: string;
};

/** Private admin/workflow result. Worker contexts expose only the closed flag. */
export type CandidateResult = {
  id: string;
  /** Only persisted accepted results may be consumed by downstream stages. */
  persisted: boolean;
  candidateSetSnapshotId: string;
  taskInstanceId: string;
  blockId: string;
  definitionId: string;
  definitionVersion: number;
  status: "pending_votes" | "pending_adjudication" | "accepted";
  policy: { version: 1; rule: "strict_majority"; minimumVotes: number };
  totalVotes: number;
  counts: Record<string, number>;
  votes: Array<{
    assignmentId: string;
    annotationRevisionId: string;
    actorId: string;
    candidateId: string;
  }>;
  excludedRevisionIds: string[];
  accepted?: {
    candidateId: string;
    value: CandidateValue
    source: {
      kind: CandidateOrigin;
      labelId: string | null;
      revisionId: string | null;
      curatedCandidateId: string | null;
      fieldId: string;
      taskInstanceId: string | null;
      definitionId: string | null;
      definitionVersion: number | null;
      sourceRecordId: string | null;
      observedAt: string;
    };
  };
};
