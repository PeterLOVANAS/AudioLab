import type { ResearchBlock } from "./research-export";
/** Additive, versioned admin analytics. Counts refer to observations/pairs, never
 * dataset accuracy. Raw immutable revision identity accompanies every observation. */
export type ResultObservation = {
  workerId: string;
  displayName: string;
  assignmentId: string;
  revisionId: string | null;
  value: unknown;
  readable: unknown;
  state: "valid" | "empty" | "missing" | "invalid" | "unsubmitted";
  reason?: string;
};
export type TemporalEvent = {
  start: number;
  end: number;
  label: string;
  tierId: string;
};
export type ResultPair = {
  left: number;
  right: number;
  score: number | null;
  reason?: string;
  absenceAgreement?: boolean;
};
/** Descriptive counts within one pinned question/audio scope; never pooled
 * across unrelated ordinal option IDs. Ranks are one-based array positions. */
export type ResultDistribution = {
  counts: Array<{ id: string; label: string; count: number }>;
  ranks: Array<{ id: string; label: string; positions: number[] }>;
};
/** Administrator-only reference evaluation, separate from agreement. Original
 * private payloads are not serialized. Current-source references are not pinned
 * historical ground truth and unavailable/ambiguous mappings are never scored. */
export type ResultReference = {
  origin: "current-source";
  available: boolean;
  reason: string;
  observations: Array<{ workerId: string; match: boolean | null }>;
};
export type ResultItem = {
  key: string;
  taskInstanceId: string;
  definitionId: string;
  definitionVersion: number;
  sourceKeys: string[];
  blockId: string;
  path: string;
  block: ResearchBlock;
  audio: Array<{
    id: string;
    url: string;
    label: string;
    duration: number | null;
  }>;
  observations: ResultObservation[];
  tracks: Array<{ observation: number; events: TemporalEvent[] }>;
  pairs: ResultPair[];
  mean: number | null;
  min: number | null;
  max: number | null;
  validObservations: number;
  excludedObservations: number;
  eligiblePairs: number;
  excludedPairs: number;
  absencePairs: number;
  metric: string;
  numeric: { count: number; mean: number; min: number; max: number } | null;
  distribution?: ResultDistribution;
  reference?: ResultReference;
};
export type ResultBlock = {
  blockId: string;
  label: string;
  type: string;
  counts: Array<{ id: string; label: string; count: number }>;
  meanSimilarity: number | null;
  metric: string;
  unresolved: number;
  validComparisons: number;
  comparisons: number;
  comparisonGroups: number;
  validObservations: number;
  excludedObservations: number;
  absencePairs: number;
  numeric: ResultItem["numeric"];
};
export type JobResults = {
  analyticsVersion: "audiolab.analytics/2";
  /** Additive descriptive/reference evaluation contract within analytics/2. */
  distributionVersion?: "audiolab.distributions/1";
  complete: boolean;
  remaining: number;
  sourceItems: number;
  uniqueAudioItems: number;
  workerSubmissions: number;
  expectedAssignments: number;
  blocks: ResultBlock[];
  items: ResultItem[];
  policy: string;
};
