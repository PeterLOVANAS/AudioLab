/**
 * SQL-only layer. Never reads source_labels: imported MMAU answer keys must
 * not leak to Labellers through annotation read/write endpoints.
 *
 * Concurrency is enforced in migration 0007 by BEFORE INSERT trigger.
 * It rejects stale expectedRevision in the DATABASE, not merely in JS.
 */
import type { AnnotationRevision } from "@/lib/contracts/annotation-api";

export type RevisionRow = {
  id: string; assignmentId: string; labellerId: string;
  revision: number; expectedRevision: number;
  status: "draft" | "submitted"; answersJson: string; createdAt: string;
};

function toRevision(row: RevisionRow): AnnotationRevision {
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    labellerId: row.labellerId,
    revision: row.revision,
    expectedRevision: row.expectedRevision,
    status: row.status,
    answers: JSON.parse(row.answersJson) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

const SELECT_REVISION = `
  SELECT id, assignment_id AS assignmentId,
    labeller_user_id AS labellerId, revision,
    expected_revision AS expectedRevision,
    status, answers_json AS answersJson, created_at AS createdAt
  FROM annotation_revisions
`;

export const annotationRepository = {
  /** A latest-revision query uses the UNIQUE(assignment_id,revision) index. */
  async current(db: D1Database, assignmentId: string): Promise<AnnotationRevision | null> {
    const row = await db.prepare(`${SELECT_REVISION}
      WHERE assignment_id = ? ORDER BY revision DESC LIMIT 1`
    ).bind(assignmentId).first<RevisionRow>();
    return row ? toRevision(row) : null;
  },

  async history(db: D1Database, assignmentId: string): Promise<AnnotationRevision[]> {
    const result = await db.prepare(`${SELECT_REVISION}
      WHERE assignment_id = ? ORDER BY revision ASC LIMIT 200`
    ).bind(assignmentId).all<RevisionRow>();
    return result.results.map(toRevision);
  },

  /**
   * ONE atomic INSERT. Its triggers (1) check the correct labeller and
   * expectedRevision, (2) append history, (3) update assignments.status.
   * If a second tab submits a stale revision, SQLite aborts the INSERT and
   * all three changes are rejected together.
   */
  async append(db: D1Database, input: {
    id: string; assignmentId: string; labellerId: string;
    expectedRevision: number; status: "draft" | "submitted";
    answers: Record<string, unknown>;
  }): Promise<void> {
    await db.prepare(`
      INSERT INTO annotation_revisions (
        id, assignment_id, labeller_user_id, revision,
        expected_revision, status, answers_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id, input.assignmentId, input.labellerId,
      input.expectedRevision + 1,
      input.expectedRevision, input.status,
      JSON.stringify(input.answers)
    ).run();
  },
};
