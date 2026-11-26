/** A source item is independent of its audio; several questions may share one WAV. */
export type AllocationItem = {
  key: string;
  assetId: string;
  sourceId: string | null;
  recordId: string | null;
  originalPath: string;
  question: string | null;
  sampleId: string | null;
  itemId: string | null;
  sourceVersion: string | null;
};
/** Explicit pairs are reviewable and retained when retrying confirmation. */
export type AllocationPair = { itemKey: string; labellerId: string };
export type AllocationRequest = {
  projectId: string;
  adminId: string;
  datasetId: string;
  definitionId: string;
  definitionVersion: number;
  itemKeys: string[];
  labellerIds: string[];
  independentLabellers: number;
  mode: "fixed" | "balanced";
};
export type AllocationPreview = {
  items: AllocationItem[];
  pairs: Array<AllocationPair & { labellerName: string; existing: boolean }>;
  uniqueItems: number;
  assignments: number;
  newAssignments: number;
  perWorker: Array<{
    userId: string;
    name: string;
    proposed: number;
    existing: number;
  }>;
};
