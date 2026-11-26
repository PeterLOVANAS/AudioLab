import type { AllocationItem, AllocationPair } from "./assignment-allocation";
/** Project profile fields are eligibility information, never security roles. */
export type WorkerProfile = {
  userId: string;
  displayName: string;
  country: string;
  profession: string;
  languages: string[];
  experienceYears: number;
  active: boolean;
  accountReady: boolean;
  metadata: Record<string, string>;
};
export type Team = { id: string; name: string; memberIds: string[] };
export type JobInput = {
  jobId: string;
  projectId: string;
  name: string;
  teamId?: string;
  datasetId: string;
  definitionId: string;
  definitionVersion: number;
  mode: "individual" | "voting";
  seed: string;
  itemKeys: string[];
  workerIds: string[];
  sampleCount: number;
  useEntireDataset?:boolean;
};
export type JobPlan = {
  teamName: string | null;
  datasetTotalItems: number;
  input: JobInput;
  items: AllocationItem[];
  workers: WorkerProfile[];
  /** Missing on historical one-item plans; every batch key is its first source item. */
  batches?:Array<{key:string;itemKeys:string[]}>;
  recordingsPerTask?:number;
  batchPolicy?:"flexible-v1";
  /** One worker/task pair; itemKey is the batch primary when batches exists. */
  pairs: AllocationPair[];
  counts: Record<string, number>;
  hash: string;
};
export type JobSummary = {
  id: string;
  projectId: string;
  name: string;
  teamName: string | null;
  definitionName: string;
  definitionVersion: number;
  mode: "individual" | "voting";
  createdAt: string;
  launchedAt: string | null;
  /** Only requested by admin history/export lists; active boards exclude these. */
  deletedAt?:string|null;
  items: number;
  workers: number;
  assignments: number;
  submitted: number;
  fullyLabelledItems: number;
};
