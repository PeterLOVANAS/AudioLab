/**
 * Lesson 8 HTTP data-transfer types.
 *
 * The project already has lib/contracts/assignments.ts. We DO NOT overwrite
 * that earlier conceptual contract. These types describe the JSON returned
 * by the real D1-backed Lesson 8 API. We can consolidate types later.
 *
 * "User ID" here is an untrusted string entered for LOCAL TESTING.
 * It is NOT a verified login identity; actual authentication comes later.
 */
export type MemberRole = "admin" | "labeller";

export type ProjectMemberRecord = {
  projectId: string;
  userId: string;
  displayName: string;
  role: MemberRole;
  createdAt: string;
};

export type AssignmentStatus =
  "assigned" | "in_progress" | "submitted" | "reviewed";

/** Lightweight row displayed in an Admin table or Labeller queue. */
export type AssignmentSummary = {
  id: string;
  projectId: string;
  taskInstanceId: string;
  labellerId: string;
  labellerName: string;
  status: AssignmentStatus;
  assignedAt: string;
  startedAt: string | null;
  assetId: string;
  originalPath: string;
  audioUrl: string;
  definitionId: string;
  definitionVersion: number;
  definitionName: string;
};
