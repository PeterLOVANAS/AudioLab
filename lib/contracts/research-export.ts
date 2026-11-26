import type {
  TaskInstancePreview,
  PublishedDefinitionData,
} from "./task-instances";
import type { JobSummary } from "./team-jobs";
export type ResearchBlock = PublishedDefinitionData["blocks"][number];
/** Submitted revision identity is carried beside every extracted audio answer. */
export type ExportRevision = {
  assignmentId: string;
  workerId: string;
  revisionId: string;
  revision: number;
  submittedAt: string;
  answers: Record<string, unknown>;
  /** Additive labels from the immutable resolved form; raw IDs above remain unchanged. */
  readableAnswers?: Record<
    string,
    { label: string; type: string; value: unknown }
  >;
};
export type ExportAnswer = Omit<
  ExportRevision,
  "answers" | "readableAnswers"
> & { value: unknown; readableValue?: unknown };
export type ChoiceDistribution = {
  submitted: number;
  counts: Array<{ id: string; label: string; count: number }>;
};
export type ExportAudioBlock = {
  taskInstanceId: string;
  block: ResearchBlock;
  annotations: ExportAnswer[];
  /** Present only for Voting choice-style blocks; independent answers remain in JSON. */
  distribution?: ChoiceDistribution;
};
export type ExportAudioItem = {
  audioId: string;
  originalPath: string;
  audioUrl: string;
  durationSeconds?: number | null;
  sourceItems: Array<{
    sourceKey: string;
    sampleId: string | null;
    itemId: string | null;
    sourceRecordId: string | null;
    sourceVersion: string | null;
    fieldsOrigin: "pinned-task-input" | "current-source" | "none";
    sourceUpdatedAt?: string;
    /** Worker-visible fields only; fieldsOrigin distinguishes historical/current context. */
    fields: Array<{ id: string; type: string; value: unknown }>;
    blocks: ExportAudioBlock[];
  }>;
  /** Batch-level Ranking/Audio Comparison answers live here, not duplicated as per-audio values. */
  taskReferences: string[];
};
export type ExportTask = {
  id: string;
  task: TaskInstancePreview;
  sourceKeys: string[];
  annotations: ExportRevision[];
  expectedSubmissions: number;
  distributions: Array<{
    blockId: string;
    audioPosition: number | null;
    comparisonIndex?: number;
    value: ChoiceDistribution;
  }>;
};
export type ResearchExport = {
  schemaVersion: "audiolab.research-export/1";
  /** Same authoritative final analytics as the progress API; absent on older exports. */
  analytics?: import("./job-results").JobResults;
  generatedAt: string;
  projectId: string;
  datasetId: string;
  job: JobSummary;
  policy: {
    revisions: "latest-submitted";
    draftsIncluded: false;
    hiddenReferencesIncluded: false;
    workerIdsIncluded: true;
  };
  tasks: ExportTask[];
  audioItems: ExportAudioItem[];
  totals: {
    sourceItems: number;
    taskInstances: number;
    expectedSubmissions: number;
    exportedSubmissions: number;
    annotatedAudio: number;
  };
};
