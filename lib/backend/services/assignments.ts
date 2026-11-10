/**
 * Assignment service = business rules, not SQL syntax or HTTP status codes.
 *
 * Flow: HTTP route -> Zod -> service -> repository -> D1.
 * We verify both project ownership and membership before writing anything.
 * Unlike an imported MMAU answer, an assignment is new platform state.
 */
import type {
  CreateAssignmentInput,
  CreateMemberInput,
} from "@/lib/backend/validation/assignments";
import { assignmentRepository as repo } from "@/lib/backend/repositories/assignments";
import { taskInstanceService } from "@/lib/backend/services/task-instances";

/** Specific errors let routes return 404 or 409 instead of vague 500s. */
export class AssignmentRelatedNotFoundError extends Error {}
export class AssignmentNotFoundError extends Error {}
export class AssignmentProjectMismatchError extends Error {}
export class AssignmentRoleError extends Error {}
export class AssignmentConflictError extends Error {}

export const assignmentService = {
  /**
   * Create one local DEV identity in one project.
   * This is NOT account registration and does not verify a real human.
   * An eventual authentication integration will replace this dev helper.
   */
  async addMember(db: D1Database, input: CreateMemberInput) {
    if (!(await repo.projectExists(db, input.projectId))) {
      throw new AssignmentRelatedNotFoundError("Project not found.");
    }
    const inserted = await repo.insertMember(db, input);
    if (!inserted) {
      throw new AssignmentConflictError(
        "This user is already registered in this project.",
      );
    }
    // Read back the canonical database representation including createdAt.
    return repo.member(db, input.projectId, input.userId);
  },

  async listMembers(db: D1Database, projectId: string) {
    if (!(await repo.projectExists(db, projectId))) {
      throw new AssignmentRelatedNotFoundError("Project not found.");
    }
    return repo.listMembers(db, projectId);
  },

  /**
   * Assign one task instance to one registered Labeller.
   * Same task + two different labellers is allowed (independent votes).
   * Same task + same labeller is rejected (unique constraint).
   */
  async create(db: D1Database, input: CreateAssignmentInput) {
    if (!(await repo.projectExists(db, input.projectId))) {
      throw new AssignmentRelatedNotFoundError("Project not found.");
    }
    const instance = await repo.instanceProject(db, input.taskInstanceId);
    if (!instance) {
      throw new AssignmentRelatedNotFoundError("Task instance not found.");
    }
    if (instance.projectId !== input.projectId) {
      throw new AssignmentProjectMismatchError(
        "Task instance belongs to another project.",
      );
    }
    const member = await repo.member(db, input.projectId, input.labellerId);
    if (!member) {
      throw new AssignmentRelatedNotFoundError(
        "Labeller is not a member of this project.",
      );
    }
    if (member.role !== "labeller") {
      throw new AssignmentRoleError(
        "Only a member with the labeller role can be assigned.",
      );
    }
    const id = crypto.randomUUID();
    const inserted = await repo.insertAssignment(db, {
      id,
      projectId: input.projectId,
      taskInstanceId: input.taskInstanceId,
      labellerId: input.labellerId,
    });
    if (!inserted) {
      throw new AssignmentConflictError(
        "This task instance has already been assigned to that labeller.",
      );
    }
    return this.getSummary(db, id);
  },

  async getSummary(db: D1Database, id: string) {
    const assignment = await repo.find(db, id);
    if (!assignment) throw new AssignmentNotFoundError("Assignment not found.");
    return assignment;
  },

  /**
   * Retrieve the full published task preview for one assignment.
   * This reuses Lesson 7's safe preview; it never joins source_labels.
   * NOTE: DEV-ONLY route until real authorization is implemented.
   */
  async detail(db: D1Database, id: string) {
    const assignment = await this.getSummary(db, id);
    const taskInstance = await taskInstanceService.get(
      db,
      assignment.taskInstanceId,
    );
    return { assignment, taskInstance };
  },

  async list(db: D1Database, projectId: string, labellerId?: string) {
    if (!(await repo.projectExists(db, projectId))) {
      throw new AssignmentRelatedNotFoundError("Project not found.");
    }
    if (labellerId && !(await repo.member(db, projectId, labellerId))) {
      throw new AssignmentRelatedNotFoundError("Project member not found.");
    }
    return repo.list(db, projectId, labellerId);
  },

  async queue(db: D1Database, projectId: string, labellerId: string) {
    const member = await repo.member(db, projectId, labellerId);
    if (!member) {
      throw new AssignmentRelatedNotFoundError(
        "Labeller not found in this project.",
      );
    }
    if (member.role !== "labeller") {
      throw new AssignmentRoleError(
        "This member does not have the labeller role.",
      );
    }
    return repo.queue(db, projectId, labellerId);
  },

  /**
   * Start a single assignment. The SQL UPDATE is conditional and atomic.
   * The client must NOT be allowed to mark a task "submitted" here: that
   * transition will be tied to saving valid answers in the next lesson.
   */
  async start(db: D1Database, id: string, labellerId: string) {
    const current = await this.getSummary(db, id);
    if (current.labellerId !== labellerId) {
      throw new AssignmentConflictError(
        "Assignment belongs to a different labeller.",
      );
    }
    const changed = await repo.start(db, id, labellerId);
    if (!changed) {
      throw new AssignmentConflictError(
        `Cannot start assignment in state '${current.status}'.`,
      );
    }
    return this.getSummary(db, id);
  },
};
