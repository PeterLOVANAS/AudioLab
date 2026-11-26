/**
 * Frontend/backend shared DTOs for the Lesson 7 Task Instance API.
 * DTO = Data Transfer Object: the exact JSON shape the frontend receives.
 *
 * Don't confuse TaskInstancePreview with the older in-memory TaskInstance
 * type in lib/contracts/tasks.ts. That legacy type describes task payloads;
 * THIS file describes the versioned database-backed HTTP response.
 *
 * `sourceRecord` holds a public question/choices but NEVER an answer.
 */
export type PublishedDefinitionData = {
  id: string;
  version: number;
  name: string;
  description: string;
  domain: "sound" | "speech" | "general";
  instructions: string;
  instructionBinding?: import("@/lib/contracts/input-bindings").DatasetTextBinding;
  blocks: Array<{
    id: string;
    type: string;
    label: string;
    required: boolean;
    [field: string]: unknown;
  }>;
  policy: {
    requiredIndependentVotes: number;
    blindToOthers: boolean;
    requiresReview: boolean;
  };
  workspace?: Record<string, unknown>;
};

/** Compact row for the future Admin or Dataset Registry frontend. */
export type TaskInstanceSummary = {
  id: string;
  projectId: string;
  assetId: string;
  originalPath: string;
  definitionId: string;
  definitionVersion: number;
  definitionName: string;
  createdAt: string;
};

/** Detailed read-only preview. Not a labeller assignment or answer record. */
export type TaskInstancePreview = TaskInstanceSummary & {
  audioUrl: string;
  definition: PublishedDefinitionData;
  /** Instance-local projection of the immutable definition and public source snapshot. */
  resolvedDefinition?: PublishedDefinitionData;
  /** Seeded only before the first annotation revision; saved drafts always win. */
  initialAnswers?: Record<string, unknown>;
  /** Public traceability; restricted source provenance remains in the stored snapshot. */
  inputContext?: { snapshotId: string; sourceKind: "dataset"; prefilledBlockIds: string[] };
  /** Fixed ordered audio list; legacy one-audio tasks return a singleton. */
  audioAssets?: Array<{ id: string; url: string; position: number; originalPath?: string; durationSeconds?: number | null; sampleRate?: number | null; channels?: number | null }>;
  /** Curated candidate labels only; private source_labels are never returned. */
  candidates?: Array<{ id: string; label: string; provenance: string }>;
  /** Owner-specific anonymous sets, fetched separately from the unscoped task detail. */
  candidateSets?: Record<string, import("./candidate-sets").CandidateSetView>;
  sourceRecord: null | {
    sourceRecordId: string;
    question: string | null;
    choices: string[] | null;
  };
};
