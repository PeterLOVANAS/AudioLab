/**
 * AudioLab Task Definitions — SERVICE (BUSINESS RULES) LAYER
 * ---------------------------------------------------------
 * Services decide WHAT an operation means, not HOW an HTTP route is written
 * or HOW SQL columns are named. The repository handles database details.
 *
 * A Task Definition is an editable annotation PROTOCOL, independent of any
 * individual WAV. Future task instances will link a published version of
 * this protocol to a particular MMAU audio asset.
 */
import type { TaskDraft } from "@/lib/backend/validation/task-definitions";
import { taskDefinitionRepository as repo } from "@/lib/backend/repositories/task-definitions";

/**
 * Distinct error classes let the HTTP layer map failures cleanly:
 * - missing project -> 404
 * - missing definition/version -> 404
 * - outdated revision/version -> 409
 *
 * We don't return HTTP responses directly from the service because that
 * would couple reusable business logic to web transport details.
 */
export class ProjectNotFoundError extends Error {}
export class TaskDefinitionNotFoundError extends Error {}
export class TaskDefinitionConflictError extends Error {}

/**
 * Convert a D1 row into the API-facing object.
 * `Awaited<ReturnType<typeof repo.find>>` means "the resolved return type
 * of our async repo.find method." `NonNullable` removes `null` after the
 * caller has already checked that the row exists.
 *
 * JSON.parse reverses the repository's JSON.stringify(draft) operation.
 * The `as TaskDraft` assertion does not validate arbitrary DB text by
 * itself—we rely on prior request validation and SQLite json_valid().
 */
function mapRow(row: NonNullable<Awaited<ReturnType<typeof repo.find>>>) {
  return {
    id: row.id,
    projectId: row.projectId,
    draft: JSON.parse(row.draftJson) as TaskDraft,
    draftRevision: row.draftRevision,
    publishedVersion: row.publishedVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const taskDefinitionService = {
  /**
   * List only a project's definitions. Checking the project's existence
   * distinguishes an unknown project (404) from a valid empty list (200).
   */
  async list(db: D1Database, projectId: string) {
    if (!(await repo.projectExists(db, projectId))) {
      throw new ProjectNotFoundError("Project not found.");
    }
    return repo.list(db, projectId);
  },

  /** Return current editable draft with its concurrency/version counters. */
  async get(db: D1Database, id: string) {
    const row = await repo.find(db, id);
    if (!row) {
      throw new TaskDefinitionNotFoundError("Task definition not found.");
    }
    return mapRow(row);
  },

  /**
   * Create a new protocol within an existing research project.
   * `crypto.randomUUID()` assigns a stable server-generated identifier.
   * The new definition starts with draftRevision=1, publishedVersion=0.
   */
  async create(db: D1Database, projectId: string, draft: TaskDraft) {
    if (!(await repo.projectExists(db, projectId))) {
      throw new ProjectNotFoundError("Project not found.");
    }
    const id = crypto.randomUUID();
    await repo.insert(db, id, projectId, draft);
    return this.get(db, id);
  },

  /**
   * Replace an existing editable draft, but only if its revision hasn't
   * changed since the editor last loaded it. Stale writes -> HTTP 409.
   * We do NOT modify historical published snapshots during this operation.
   */
  async update(
    db: D1Database,
    id: string,
    expectedRevision: number,
    draft: TaskDraft,
  ) {
    if (!(await repo.find(db, id))) {
      throw new TaskDefinitionNotFoundError("Task definition not found.");
    }
    if (!(await repo.replaceDraft(db, id, expectedRevision, draft))) {
      throw new TaskDefinitionConflictError(
        "Draft revision changed. Reload before editing.",
      );
    }
    return this.get(db, id);
  },

  /**
   * Publish the current draft as a stable version, e.g. v1 or v2.
   * A publication is a database snapshot, not a separate WAV or task instance.
   * Future assignments should reference BOTH definition ID and version.
   */
  async publish(
    db: D1Database,
    id: string,
    expectedRevision: number,
    expectedPublishedVersion: number,
  ) {
    if (!(await repo.find(db, id))) {
      throw new TaskDefinitionNotFoundError("Task definition not found.");
    }

    const published = await repo.publish(
      db,
      id,
      expectedRevision,
      expectedPublishedVersion,
    );
    if (!published) {
      throw new TaskDefinitionConflictError(
        "Draft or published version changed. Reload before publishing.",
      );
    }

    // The client predicted N+1 from the published counter it last saw.
    const version = expectedPublishedVersion + 1;
    const snapshot = await repo.publishedVersion(db, id, version);
    if (!snapshot) {
      // A successful commit without a retrievable snapshot is an internal
      // consistency error, not a normal missing-resource response.
      throw new Error("Published snapshot missing after commit.");
    }

    return {
      id,
      version,
      // Prefix stable identity/version onto the original draft fields.
      definition: {
        id,
        version,
        ...(JSON.parse(snapshot.definitionJson) as TaskDraft),
      },
      publishedAt: snapshot.publishedAt,
    };
  },

  /**
   * Read a SPECIFIC published snapshot. Unlike `get()`, it never reads the
   * current mutable draft content. This is essential for reproducible labels.
   */
  async getPublished(db: D1Database, id: string, version: number) {
    if (!(await repo.find(db, id))) {
      throw new TaskDefinitionNotFoundError("Task definition not found.");
    }
    const snapshot = await repo.publishedVersion(db, id, version);
    if (!snapshot) {
      throw new TaskDefinitionNotFoundError("Published version not found.");
    }
    return {
      id,
      version,
      definition: {
        id,
        version,
        ...(JSON.parse(snapshot.definitionJson) as TaskDraft),
      },
      publishedAt: snapshot.publishedAt,
    };
  },
};
