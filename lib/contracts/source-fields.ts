/** Original dataset fields, independent of later human annotation revisions. */
export type SourceFieldType =
  | "string"
  | "string[]"
  | "json"
  | "choices"
  | "textgrid"
  | "number"
  | "boolean";
export type SourceFieldId = string;

/** Field-level privacy and storage identity. Arbitrary JSON is admin-only by default. */
export type SourceFieldDescriptor = {
  id: SourceFieldId;
  type: SourceFieldType;
  visibility: "worker" | "admin";
  provenance: "source_records" | "source_labels";
};

/**
 * Identity of the currently read imported value, not an immutable snapshot.
 * sourceRecordId is the internal DB key; recordId is the external dataset ID.
 * Import upserts can keep these IDs while changing values. Timestamps describe
 * that observation only: they are not unique versions or C03 snapshot IDs.
 */
export type SourceFieldProvenance = {
  datasetId: string;
  sourceRecordId: string;
  recordId: string;
  assetId: string;
  sourceUpdatedAt: string;
  labelId?: string;
  labelProvenance?: string;
  labelUpdatedAt?: string;
};

/** Runtime callers must inspect the descriptor and validate unknown JSON before binding it. */
export type SourceFieldValue = {
  field: SourceFieldDescriptor;
  value: unknown;
  provenance: SourceFieldProvenance;
};

/** Admin source response; restricted values must never be forwarded as worker context. */
export type SourceFieldPayload = {
  projectId: string;
  datasetId: string;
  recordId: string;
  audio: { assetId: string; url: string };
  fields: SourceFieldValue[];
};

/** Worker projection omits labels, arbitrary metadata and private provenance entirely. */
export type WorkerSourcePayload = {
  audioUrl: string;
  fields: { field: SourceFieldDescriptor; value: unknown }[];
};

/** Extend T01's catalog; preserve its field IDs and order for existing Builder previews. */
export const SOURCE_FIELD_CATALOG: readonly SourceFieldDescriptor[] = [
  {
    id: "question",
    type: "string",
    visibility: "worker",
    provenance: "source_records",
  },
  {
    id: "choices",
    type: "string[]",
    visibility: "worker",
    provenance: "source_records",
  },
  {
    id: "early_annotation",
    type: "json",
    visibility: "admin",
    provenance: "source_labels",
  },
  {
    id: "reference_answer",
    type: "json",
    visibility: "admin",
    provenance: "source_labels",
  },
  {
    id: "metadata",
    type: "json",
    visibility: "admin",
    provenance: "source_records",
  },
];

/** Authoring identity plus either worker-safe or explicit admin preview fields.
 * Do not infer admin access from projectId's presence; access is explicit.
 */
export type SourcePreviewPayload = WorkerSourcePayload & {
  projectId: string;
  datasetId: string;
  recordId: string;
  audio: { assetId: string; url: string };
  access: "worker" | "admin";
};
