/**
 * AudioLab Task Definitions — REPOSITORY (DATABASE) LAYER
 * ------------------------------------------------------
 * All raw SQL for Task Definitions lives here.
 *
 * Why separate this from a service or HTTP route?
 * - Routes know HTTP and status codes.
 * - Services know domain rules ("project must exist", version conflicts).
 * - Repositories know TABLES, SQL, parameter binding, and database results.
 *
 * Keeping these responsibilities separate lets you change database queries
 * without forcing teammates to rewrite their React UI or business rules.
 *
 * D1Database comes from generated Cloudflare Worker bindings/types.
 * Every `?` placeholder is filled by `.bind(...)` rather than building SQL
 * by concatenating untrusted values (which risks SQL injection).
 */
import type { TaskDraft } from "@/lib/backend/validation/task-definitions";

/**
 * A database ROW is not necessarily the same shape as an API response.
 * We alias snake_case SQL columns into camelCase names, but draftJson is
 * still a JSON STRING. The service will parse it into a TaskDraft object.
 */
export type TaskDefinitionRow = {
  id: string;
  projectId: string;
  draftJson: string;
  draftRevision: number;
  publishedVersion: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Lists need just a few summary fields, not the full block configuration.
 * Keeping the list response small is useful for the Task Builder sidebar.
 */
export type TaskDefinitionSummaryRow = {
  id: string;
  projectId: string;
  name: string;
  domain: string;
  draftRevision: number;
  publishedVersion: number;
  updatedAt: string;
};

// Common SELECT fragment used by single-definition lookups.
// `AS projectId` is an SQL alias, NOT a TypeScript assignment.
const baseSelect = `
  SELECT id, project_id AS projectId, draft_json AS draftJson,
    draft_revision AS draftRevision, published_version AS publishedVersion,
    created_at AS createdAt, updated_at AS updatedAt
  FROM task_definitions
`;

export const taskDefinitionRepository = {
  /**
   * Read the projects table to validate a foreign-key target up front.
   * `.first<T>()` returns the first matched row, or null if none exists.
   * The LIMIT 1 makes our intent explicit: existence, not a full listing.
   */
  async projectExists(db: D1Database, projectId: string): Promise<boolean> {
    const row = await db
      .prepare("SELECT id FROM projects WHERE id = ? LIMIT 1")
      .bind(projectId)
      .first<{ id: string }>();

    return row !== null;
  },

  /**
   * Get task-definition summaries owned by ONE project.
   * `json_extract` is SQLite's JSON function. It reads only the name/domain
   * from `draft_json` without sending every saved annotation block.
   * `.all<T>()` returns a result object; `.results` is its row array.
   */
  async list(
    db: D1Database,
    projectId: string,
  ): Promise<TaskDefinitionSummaryRow[]> {
    const result = await db
      .prepare(
        `
      SELECT id, project_id AS projectId,
        json_extract(draft_json, '$.name') AS name,
        json_extract(draft_json, '$.domain') AS domain,
        draft_revision AS draftRevision,
        published_version AS publishedVersion,
        updated_at AS updatedAt
      FROM task_definitions
      WHERE project_id = ?
      ORDER BY updated_at DESC, id DESC
    `,
      )
      .bind(projectId)
      .all<TaskDefinitionSummaryRow>();

    return result.results;
  },

  /**
   * Find one definition, independent of project listing.
   * Service/authorization layers must eventually verify who may read it;
   * knowing a UUID alone must NOT grant access in shared deployment.
   */
  async find(db: D1Database, id: string): Promise<TaskDefinitionRow | null> {
    return await db
      .prepare(`${baseSelect} WHERE id = ?`)
      .bind(id)
      .first<TaskDefinitionRow>();
  },

  /**
   * Create a new draft; SQLite supplies default counters (revision=1,
   * published version=0) and timestamps via the 0004 migration.
   * `JSON.stringify` serializes a checked JS object into D1's TEXT column.
   * Actual WAV bytes and original MMAU reference answers are NOT saved here.
   */
  async insert(
    db: D1Database,
    id: string,
    projectId: string,
    draft: TaskDraft,
  ): Promise<void> {
    await db
      .prepare(
        `
      INSERT INTO task_definitions (id, project_id, draft_json)
      VALUES (?, ?, ?)
    `,
      )
      .bind(id, projectId, JSON.stringify(draft))
      .run();
  },

  /**
   * Optimistic concurrency for EDITING.
   *
   * Example:
   *   Friend A reads draft_revision=3.
   *   Friend B saves an edit; database becomes revision=4.
   *   Friend A tries to save with expectedRevision=3.
   *
   * The WHERE clause finds no row (revision is now 4), so the update
   * changes 0 rows. The service converts that into HTTP 409 Conflict.
   * This is safer than blindly overwriting Friend B's modifications.
   */
  async replaceDraft(
    db: D1Database,
    id: string,
    expectedRevision: number,
    draft: TaskDraft,
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `
      UPDATE task_definitions
      SET draft_json = ?,
          draft_revision = draft_revision + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND draft_revision = ?
    `,
      )
      .bind(JSON.stringify(draft), id, expectedRevision)
      .run();

    // `meta.changes` is the count of rows actually changed by the query.
    return result.meta.changes === 1;
  },

  /**
   * Optimistic concurrency + IMMUTABLE SNAPSHOT for PUBLISHING.
   *
   * `expectedRevision` protects against publishing a changed draft.
   * `expectedPublishedVersion` protects against simultaneous publication.
   *
   * Two statements run in a D1 `batch()` transaction:
   *  (1) Increment current published_version ONLY if both counters match.
   *  (2) Copy the current draft_json to task_definition_versions as a new
   *      frozen snapshot at that version number.
   *
   * `INSERT ... SELECT` avoids fetching JSON into JS and writing it back:
   * the snapshot is copied directly from the DB's current draft row.
   *
   * NOTE: We return false if either statement changed != 1. The service
   * then reports a version conflict. A future refinement may choose an
   * explicit abort condition inside the SQL transaction for stricter
   * all-or-nothing conflict semantics, but keep this implementation the
   * same as the working Lesson 6 bundle for now.
   */
  async publish(
    db: D1Database,
    id: string,
    expectedRevision: number,
    expectedPublishedVersion: number,
  ): Promise<boolean> {
    const nextVersion = expectedPublishedVersion + 1;

    const result = await db.batch([
      // Statement 1: bump the number stored on the editable parent record.
      db
        .prepare(
          `
        UPDATE task_definitions
        SET published_version = published_version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND draft_revision = ? AND published_version = ?
      `,
        )
        .bind(id, expectedRevision, expectedPublishedVersion),

      // Statement 2: create a historical snapshot for version N.
      // ON CONFLICT prevents another row with the same (definition,version).
      db
        .prepare(
          `
        INSERT INTO task_definition_versions
          (definition_id, version, definition_json)
        SELECT id, published_version, draft_json
        FROM task_definitions
        WHERE id = ? AND draft_revision = ? AND published_version = ?
        ON CONFLICT(definition_id, version) DO NOTHING
      `,
        )
        .bind(id, expectedRevision, nextVersion),
    ]);

    return result[0].meta.changes === 1 && result[1].meta.changes === 1;
  },

  /**
   * Retrieve historical publication by the composite key (ID + version).
   * This SELECT reads the frozen snapshot, NOT the current mutable draft.
   */
  async publishedVersion(
    db: D1Database,
    id: string,
    version: number,
  ): Promise<{ definitionJson: string; publishedAt: string } | null> {
    return await db
      .prepare(
        `
      SELECT definition_json AS definitionJson,
             published_at AS publishedAt
      FROM task_definition_versions
      WHERE definition_id = ? AND version = ?
    `,
      )
      .bind(id, version)
      .first<{
        definitionJson: string;
        publishedAt: string;
      }>();
  },
};
