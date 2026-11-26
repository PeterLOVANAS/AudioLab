/** Missing data never silently switches source records or imports hidden labels. */
export type MissingValuePolicy = "block" | "empty" | "use_default";

/** Current scalar dataset binding. Ground-truth fields are not worker-safe sources. */
export type DatasetTextBinding = {
  kind: "dataset";
  fieldId: string;
  type: "string";
  missingValuePolicy?: MissingValuePolicy;
};

/** Existing T02 targets plus a text value's explicit display/initial-answer mode. */
export type SourceBindings = {
  /** Private references require explicit trainingAnswerPreview and a server-pinned release. */
  preview?: {
    kind: "dataset";
    fieldId: string;
    type: "string" | "number" | "boolean" | "choices" | "textgrid" | "json";
  };
  label?: DatasetTextBinding;
  helpText?: DatasetTextBinding;
  options?: {
    kind: "dataset";
    fieldId: string;
    type: "string[]" | "choices" | "string";
    format?: import("@/lib/frontend/choice-source").ChoiceFormat;
    delimiter?: string;
    stripPrefix?: boolean;
    missingValuePolicy?: "block" | "use_default";
  };
  value?: Omit<DatasetTextBinding, "type"> & {
    type: "string" | "textgrid";
    mode: "reference" | "read_only" | "prefill";
    /** Used only with use_default; never a hidden imported answer. */
    fallback?: string;
  };
};

/**
 * Immutable public inputs owned by a Task Instance, not the reusable definition.
 * ID equals that instance's ID. Import timestamps describe the source observation;
 * the snapshot itself pins its values even if the imported row later changes.
 * Arbitrary metadata and unreleased labels never enter this contract. Explicitly
 * worker-visible preannotation fields may seed editable answers with pinned provenance;
 * trainingPreviews separately pins only deliberately released choice answers.
 */
export type TaskInputSnapshot = {
  schemaVersion: 1;
  id: string;
  definitionId: string;
  definitionVersion: number;
  source: {
    kind: "dataset";
    projectId: string;
    datasetId: string;
    assetId: string;
    sourceRecordId: string;
    recordId: string;
    sourceUpdatedAt: string;
  };
  publicFields?: import("./source-fields").WorkerSourcePayload["fields"];
  /** Only the selected reference is intentionally released in new training tasks.
   * Other private fields/labels remain absent. Existing snapshots never change. */
  trainingPreviews?: Array<{
    blockId: string;
    fieldId: "reference_answer";
    value: unknown;
  }>;
  /** Ordered immutable public inputs for every audio slot; absent on legacy singleton tasks. */
  batch?: Omit<TaskInputSnapshot, "batch">[];
  question?: string;
  choices?: string[];
};
