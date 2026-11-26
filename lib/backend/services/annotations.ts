/**
 * Annotation business logic — Lesson 9.
 *
 * Read path:
 *   GET -> assignment lookup -> labeller check -> revisions in D1
 * Write path:
 *   POST -> assignment lookup -> published task snapshot -> validate
 *        -> single INSERT with atomic triggers -> read new revision
 *
 * Crucial distinction: source_labels contains the original MMAU answer,
 * whereas annotation_revisions contains NEW human observations. We NEVER
 * consult source_labels during human entry/validation: selection votes use
 * immutable, explicitly curated early-annotation snapshots, never answer keys.
 */
import type { AnnotationWriteInput } from "@/lib/backend/validation/annotations";
import type { AnnotationRevision } from "@/lib/contracts/annotation-api";
import {
  validateAnswers,
  type AnswerIssue,
} from "@/lib/backend/validation/annotation-answers";
import { annotationRepository as repo } from "@/lib/backend/repositories/annotations";
import { assignmentRepository } from "@/lib/backend/repositories/assignments";
import { candidateSetService } from "@/lib/backend/services/candidate-sets";
import { taskInstanceService } from "@/lib/backend/services/task-instances";

export class AnnotationAssignmentNotFoundError extends Error {}
export class AnnotationLabellerMismatchError extends Error {}
export class AnnotationConflictError extends Error {}
export class AnnotationAnswerError extends Error {
  constructor(public readonly issues: AnswerIssue[]) {
    super("Annotation answers do not match the published task definition.");
  }
}

/**
 * Map only known SQLite trigger failures. Never catch ALL SQL errors and
 * pretend they're revision conflicts: missing tables or broken SQL are 500s.
 */
function normalizeDbWriteError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("CANDIDATE_VOTING_CLOSED") ||
    message.includes("ANNOTATION_REVISION_CONFLICT") ||
    message.includes("ANNOTATION_NOT_WRITABLE") ||
    message.includes("ANNOTATION_BAD_REVISION_SEQUENCE") ||
    message.includes(
      "UNIQUE constraint failed: annotation_revisions.assignment_id",
    )
  ) {
    if (message.includes("CANDIDATE_VOTING_CLOSED"))
      throw new AnnotationConflictError(
        "Voting has closed with an accepted result. Reload the assignment.",
      );
    throw new AnnotationConflictError(
      "Revision is stale or this assignment is no longer writable. Reload the annotation.",
    );
  }
  throw error;
}

async function ensureOwner(
  db: D1Database,
  assignmentId: string,
  labellerId: string,
) {
  const assignment = await assignmentRepository.find(db, assignmentId);
  if (!assignment)
    throw new AnnotationAssignmentNotFoundError("Assignment not found.");
  if (assignment.labellerId !== labellerId) {
    throw new AnnotationLabellerMismatchError(
      "This assignment belongs to another labeller.",
    );
  }
  return assignment;
}

export const annotationService = {
  async current(db: D1Database, assignmentId: string, labellerId: string) {
    await ensureOwner(db, assignmentId, labellerId);
    return { assignmentId, current: await repo.current(db, assignmentId) };
  },

  async history(db: D1Database, assignmentId: string, labellerId: string) {
    await ensureOwner(db, assignmentId, labellerId);
    return repo.history(db, assignmentId);
  },

  async save(
    db: D1Database,
    assignmentId: string,
    input: AnnotationWriteInput,
    status: "draft" | "submitted",
  ): Promise<AnnotationRevision> {
    const assignment = await ensureOwner(db, assignmentId, input.labellerId);
    if (assignment.status === "submitted" || assignment.status === "reviewed") {
      throw new AnnotationConflictError(
        "Submitted assignments cannot be modified.",
      );
    }

    // Pull the actual published SNAPSHOT from Lesson 7, never the mutable
    // Task Definition draft. Later edits/publishes cannot change old labels.
    const task = await taskInstanceService.get(db, assignment.taskInstanceId);
    const definition = task.resolvedDefinition ?? task.definition;
    const selections = definition.blocks.some((block) => block.type === "candidate_vote" && block.candidateSource === "set")
      ? (await candidateSetService.forAssignment(db,assignmentId,input.labellerId)).context : undefined;
    const issues = validateAnswers(
      // Runtime options come from the same immutable public input snapshot as
      // the Workspace, never from the submitted form or today's mutable import.
      definition,
      input.answers,
      status === "submitted",
      {
        audioAssetCount: task.audioAssets?.length ?? 1,
        candidateIds: task.candidates?.map((candidate) => candidate.id) ?? [],
        candidateSets: selections,
      },
    );
    if (issues.length) throw new AnnotationAnswerError(issues);

    // This read is helpful for a clear 409 response, but is NOT the concurrency
    // boundary: the SQL trigger re-checks it at the instant of INSERT.
    const current = await repo.current(db, assignmentId);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw new AnnotationConflictError(
        "Outdated expectedRevision. Reload before saving.",
      );
    }

    try {
      await repo.append(db, {
        id: crypto.randomUUID(),
        assignmentId,
        labellerId: input.labellerId,
        expectedRevision: input.expectedRevision,
        status,
        answers: input.answers,
      });
    } catch (error) {
      normalizeDbWriteError(error);
    }

    // The INSERT trigger already changed assignments.status in the same
    // SQLite statement; there is no separate non-atomic state transition.
    const saved = await repo.current(db, assignmentId);
    if (!saved || saved.revision !== input.expectedRevision + 1) {
      throw new Error("Saved annotation revision could not be retrieved.");
    }
    return saved;
  },
};
