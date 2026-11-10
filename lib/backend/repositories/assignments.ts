/**
 * Repository layer: SQL-only operations on Cloudflare D1.
 *
 * SQL parameter markers '?' are bound with .bind(value) to avoid injection.
 * .first<T>() returns one row or null; .all<T>().results returns an array;
 * .run().meta.changes tells us how many rows were changed.
 *
 * Do not read source_labels here. That table contains hidden MMAU answers.
 */
import type {
  AssignmentSummary,
  ProjectMemberRecord,
} from "@/lib/contracts/assignment-api";

// SQLite uses snake_case but our HTTP/TypeScript code uses camelCase.
// SQL "AS" aliases bridge these conventions.
const SELECT_ASSIGNMENTS = `
  SELECT
    a.id, a.project_id AS projectId,
    a.task_instance_id AS taskInstanceId,
    a.labeller_user_id AS labellerId,
    m.display_name AS labellerName,
    a.status, a.assigned_at AS assignedAt,
    a.started_at AS startedAt,
    i.asset_id AS assetId,
    audio.original_path AS originalPath,
    i.definition_id AS definitionId,
    i.definition_version AS definitionVersion,
    json_extract(v.definition_json, '$.name') AS definitionName
  FROM assignments AS a
  JOIN project_members AS m
    ON m.project_id = a.project_id AND m.user_id = a.labeller_user_id
  JOIN task_instances AS i ON i.id = a.task_instance_id
  JOIN audio_assets AS audio ON audio.id = i.asset_id
  JOIN task_definition_versions AS v
    ON v.definition_id = i.definition_id
   AND v.version = i.definition_version
`;

// D1 doesn't compute a playback URL. We derive it from the stable asset ID.
// No R2 keys or private reference labels are exposed by this DTO.
type AssignmentDbRow = Omit<AssignmentSummary, "audioUrl">;
function toAssignment(row: AssignmentDbRow): AssignmentSummary {
  return { ...row, audioUrl: `/api/v1/assets/${row.assetId}/audio` };
}

type MemberDbRow = ProjectMemberRecord;

export const assignmentRepository = {
  async projectExists(db: D1Database, projectId: string): Promise<boolean> {
    const row = await db
      .prepare("SELECT id FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ id: string }>();
    return row !== null;
  },

  /** Find a member in one project; composite key prevents cross-project reuse. */
  async member(db: D1Database, projectId: string, userId: string) {
    return db
      .prepare(
        `
      SELECT project_id AS projectId, user_id AS userId,
        display_name AS displayName, role, created_at AS createdAt
      FROM project_members WHERE project_id = ? AND user_id = ?
    `,
      )
      .bind(projectId, userId)
      .first<MemberDbRow>();
  },

  async listMembers(
    db: D1Database,
    projectId: string,
  ): Promise<ProjectMemberRecord[]> {
    const result = await db
      .prepare(
        `
      SELECT project_id AS projectId, user_id AS userId,
        display_name AS displayName, role, created_at AS createdAt
      FROM project_members WHERE project_id = ?
      ORDER BY role ASC, display_name ASC, user_id ASC
      LIMIT 200
    `,
      )
      .bind(projectId)
      .all<MemberDbRow>();
    return result.results;
  },

  /** A duplicate member returns false, not an overwritten record. */
  async insertMember(
    db: D1Database,
    input: {
      projectId: string;
      userId: string;
      displayName: string;
      role: "admin" | "labeller";
    },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `
      INSERT INTO project_members (project_id, user_id, display_name, role)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO NOTHING
    `,
      )
      .bind(input.projectId, input.userId, input.displayName, input.role)
      .run();
    return result.meta.changes === 1;
  },

  /** Task instances already know which project owns them. */
  async instanceProject(db: D1Database, taskInstanceId: string) {
    return db
      .prepare(
        "SELECT project_id AS projectId FROM task_instances WHERE id = ?",
      )
      .bind(taskInstanceId)
      .first<{ projectId: string }>();
  },

  /** Two DIFFERENT labellers may be assigned to one task instance. */
  async insertAssignment(
    db: D1Database,
    input: {
      id: string;
      projectId: string;
      taskInstanceId: string;
      labellerId: string;
    },
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `
      INSERT INTO assignments (id, project_id, task_instance_id, labeller_user_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_instance_id, labeller_user_id) DO NOTHING
    `,
      )
      .bind(input.id, input.projectId, input.taskInstanceId, input.labellerId)
      .run();
    return result.meta.changes === 1;
  },

  /** One detailed assignment summary, excluding any answer keys. */
  async find(db: D1Database, id: string): Promise<AssignmentSummary | null> {
    const row = await db
      .prepare(`${SELECT_ASSIGNMENTS} WHERE a.id = ?`)
      .bind(id)
      .first<AssignmentDbRow>();
    return row === null ? null : toAssignment(row);
  },

  /** Admin table. Optional labeller filter; all records scoped to a project. */
  async list(db: D1Database, projectId: string, labellerId?: string) {
    const sql = `${SELECT_ASSIGNMENTS}
      WHERE a.project_id = ? ${labellerId ? "AND a.labeller_user_id = ?" : ""}
      ORDER BY a.assigned_at DESC, a.id DESC LIMIT 200`;
    const statement = db.prepare(sql);
    const result = labellerId
      ? await statement.bind(projectId, labellerId).all<AssignmentDbRow>()
      : await statement.bind(projectId).all<AssignmentDbRow>();
    return result.results.map(toAssignment);
  },

  /** Only unfinished work goes to a Labeller's active queue. */
  async queue(db: D1Database, projectId: string, labellerId: string) {
    const result = await db
      .prepare(
        `${SELECT_ASSIGNMENTS}
      WHERE a.project_id = ? AND a.labeller_user_id = ?
        AND a.status IN ('assigned', 'in_progress')
      ORDER BY a.assigned_at ASC, a.id ASC LIMIT 200
    `,
      )
      .bind(projectId, labellerId)
      .all<AssignmentDbRow>();
    return result.results.map(toAssignment);
  },

  /**
   * Atomic status transition: assigned -> in_progress exactly once.
   * The WHERE condition prevents two concurrent requests from both starting
   * the same assignment. A 0-row result becomes HTTP 409 in the service.
   */
  async start(
    db: D1Database,
    id: string,
    labellerId: string,
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `
      UPDATE assignments
      SET status = 'in_progress', started_at = CURRENT_TIMESTAMP
      WHERE id = ? AND labeller_user_id = ? AND status = 'assigned'
    `,
      )
      .bind(id, labellerId)
      .run();
    return result.meta.changes === 1;
  },
};
