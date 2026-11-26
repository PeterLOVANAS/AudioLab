/*
 * AudioLab 2.0 — Assignment contracts
 *
 * A Task Instance is one per-item work request. A team job groups many
 * instances/assignments into a frozen allocation campaign.
 * An assignment gives that job to one Labeller.
 *
 * Multiple Labellers may receive the same task
 * for independent annotation and voting.
 */

// The possible states of an individual assignment.
export type AssignmentStatus =
  "assigned" | "in_progress" | "submitted" | "reviewed";

// One task assigned to one Labeller.
export type Assignment = {
  id: string;
  projectId: string;
  taskInstanceId: string;
  labellerUserId: string;

  status: AssignmentStatus;

  assignedAt: string;
  updatedAt: string;
};

// Information an Admin provides when making an assignment.
export type CreateAssignmentInput = {
  projectId: string;
  taskInstanceId: string;
  labellerUserId: string;
};

// Simplified information for the Labeller's task queue.
//
// Private dataset metadata and reference answers
// are deliberately not included.
export type TaskQueueItem = {
  assignmentId: string;
  taskInstanceId: string;
  taskName: string;
  status: AssignmentStatus;
};
