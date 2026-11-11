/** F00 proposal: shared interfaces only. No persistence or runtime is installed. */
import type { AnnotationRevision } from "./annotation-api";
import type { PublishedDefinitionData } from "./task-instances";
export type Id = string;
export type DefinitionRef = Pick<PublishedDefinitionData, "id" | "version">;
export type GraphRef = { workflowId: Id; version: number };
export type AttemptRef = { batchId: Id; itemRunId: Id; nodeId: Id; attempt: number; stageRunId: Id };
export type FieldType = "boolean" | "string" | "number" | "string[]" | "intervals";
export type Field = { id: Id; type: FieldType; required: boolean };
export type Source =
  | { kind: "dataset"; fieldId: Id; visibility: "public" | "restricted" }
  | { kind: "submission"; nodeId: Id; fieldId: Id }
  | { kind: "accepted"; nodeId: Id; fieldId: Id }
  | { kind: "vote"; nodeId: Id; blockId: Id; fieldId: Id };
export type Binding = { id: Id; source: Source; targetFieldId: Id; type: FieldType; mode: "readonly" | "prefill" };
/** Project role is independent of expertise; pools are not assignments. */
export type Eligibility = { projectId: Id; role: "labeller" | "reviewer"; expertise: string[]; minimumExperience: number; excludeSubmitters: boolean };
export type Pool = { selection: { kind: "users"; ids: Id[] } | { kind: "group"; id: Id } | { kind: "eligible" }; eligibility: Eligibility };
export type Staffing = { pool: Pool; independentWorkers: number };
type NodeBase = { id: Id; label: string; position: { x: number; y: number } };
export type WorkflowNode =
  | (NodeBase & { kind: "source"; datasetId: Id; outputs: Field[] })
  | (NodeBase & { kind: "annotation"; definition: DefinitionRef | null; staffing: Staffing; inputs: Field[]; outputs: Field[] })
  | (NodeBase & { kind: "review"; upstreamNodeId: Id; selectedFields: Id[]; staffing: Staffing; inputs: Field[]; outputs: Field[]; decisions: ("approve" | "adjudicate" | "reject")[] });
/** Execution edges control readiness; bindings independently control visibility. */
export type ExecutionEdge = { id: Id; from: Id; to: Id; when: "ready" | "submitted" | "accepted" | "rejected"; rework: boolean };
export type WorkflowGraph = { schemaVersion: 1; workflowId: Id; nodes: WorkflowNode[]; edges: ExecutionEdge[]; bindings: { targetNodeId: Id; binding: Binding }[] };
export type WorkflowDraft = { graph: WorkflowGraph; revision: number };
export type PublishedWorkflow = { ref: GraphRef; graph: WorkflowGraph; publishedAt: string };
export type AttemptState = "waiting" | "ready" | "allocated" | "in_progress" | "submitted" | "accepted" | "rejected" | "cancelled";
export type SubmissionRef = Pick<AnnotationRevision, "id" | "assignmentId" | "labellerId" | "revision">;
export type Provenance = { graph: GraphRef; attempt: AttemptRef; submissions: SubmissionRef[]; reviewId?: Id; voteResultId?: Id };
export type AcceptedResult = { id: Id; fields: Record<string, unknown>; provenance: Provenance };
export type ReviewDecision = { reviewJobId: Id; expectedRevision: number; pinnedSubmissions: SubmissionRef[] } & (
  | { kind: "approve"; selectedSubmissionId: Id; accepted: AcceptedResult }
  | { kind: "adjudicate"; reason: string; accepted: AcceptedResult }
  | { kind: "reject"; feedback: string; reworkNodeId: Id }
);
export type VoteResult = { id: Id; blockId: Id; attempt: AttemptRef; distinctVoters: number; requiredVotes: number; submissions: SubmissionRef[] } & (
  | { state: "pending" | "tie" | "needs_review" }
  | { state: "resolved"; candidateId: Id; acceptedValue: string }
);
export type AllocationRequest = { requestId: Id; graph: GraphRef; attempt: AttemptRef; staffing: Staffing };
export type AllocationPreview = { request: AllocationRequest; eligibleUserIds: Id[]; excluded: { userId: Id; reason: string }[]; previewToken: string; expiresAt: string };
export type AllocationConfirmation = { requestId: Id; previewToken: string; expectedAttemptState: "ready" };
export type AllocationResult = { requestId: Id; assignmentIds: Id[] };
export type BuilderContext = { workflowId: Id; draftRevision: number; selectedNodeId: Id; returnToken: string };
export type BuilderReturn = { context: BuilderContext } & ({ outcome: "published"; definition: DefinitionRef } | { outcome: "cancelled" });
export type WorkflowError = { error: string; code: "INVALID_GRAPH" | "INVALID_BINDING" | "FORBIDDEN" | "NOT_FOUND" | "REVISION_CONFLICT" | "STALE_PREVIEW" | "INVALID_STATE"; issues?: { path: string; message: string }[] };
/** Adapter seams. Implementations must authenticate and validate unknown JSON. */
export interface OperationsAdapter {
  preview(request: AllocationRequest): Promise<AllocationPreview>;
  allocate(request: AllocationConfirmation): Promise<AllocationResult>;
  decide(decision: ReviewDecision): Promise<AcceptedResult | { rework: AttemptRef }>;
}
export interface TaskBuilderAdapter {
  fields(definition: DefinitionRef): Promise<{ inputs: Field[]; outputs: Field[] }>;
  returnToWorkflow(result: BuilderReturn): Promise<void>;
}
export interface RuntimeAdapter {
  resolveInputs(attempt: AttemptRef): Promise<{ values: Record<string, unknown>; provenance: Provenance[] }>;
  progress(attempt: AttemptRef): Promise<AttemptState>;
}
