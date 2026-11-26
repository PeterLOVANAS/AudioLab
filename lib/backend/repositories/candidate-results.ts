import type { CandidateResult } from "@/lib/contracts/candidate-sets";

/** Selected block only, not other private fields in the voter's annotation. */
export type SubmittedVoteRow = {
  sequence: number;
  id: string;
  assignmentId: string;
  actorId: string;
  assignedActor: string;
  projectId: string;
  voteJson: string | null;
};

export const candidateResultRepository = {
  /** Include all submitted rows in the watermark, including omitted/invalid votes. */
  async votes(db: D1Database, taskId: string, blockId: string) {
    return (
      await db
        .prepare(
          `SELECT r.rowid AS sequence,r.id,r.assignment_id AS assignmentId,
      r.labeller_user_id AS actorId,a.labeller_user_id AS assignedActor,a.project_id AS projectId,
      (SELECT j.value FROM json_each(r.answers_json) j WHERE j.key=? AND j.type='object') AS voteJson
      FROM annotation_revisions r JOIN assignments a ON a.id=r.assignment_id
      WHERE a.task_instance_id=? AND r.status='submitted' ORDER BY r.rowid`,
        )
        .bind(blockId, taskId)
        .all<SubmittedVoteRow>()
    ).results;
  },
  /** Accepted snapshots are terminal; later reads return the exact same provenance. */
  async accepted(
    db: D1Database,
    setId: string,
  ): Promise<CandidateResult | null> {
    const row = await db
      .prepare(
        "SELECT result_json AS json FROM candidate_vote_results WHERE candidate_set_id=? AND status='accepted'",
      )
      .bind(setId)
      .first<{ json: string }>();
    return row ? (JSON.parse(row.json) as CandidateResult) : null;
  },
  async atWatermark(
    db: D1Database,
    setId: string,
    watermark: number,
  ): Promise<CandidateResult | null> {
    const row = await db
      .prepare(
        "SELECT result_json AS json FROM candidate_vote_results WHERE candidate_set_id=? AND input_watermark=?",
      )
      .bind(setId, watermark)
      .first<{ json: string }>();
    return row ? (JSON.parse(row.json) as CandidateResult) : null;
  },
  /**
   * Optimistic aggregation at the single SQLite write boundary. If a submitted
   * revision arrived after calculation, do not persist/close a stale tally.
   * The accepted partial index and closed-vote trigger serialize finalization.
   */
  async insert(db: D1Database, result: CandidateResult, watermark: number) {
    return (
      (
        await db
          .prepare(
            `INSERT INTO candidate_vote_results(id,candidate_set_id,input_watermark,status,result_json)
      SELECT ?,?,?,?,? WHERE ?=COALESCE((SELECT MAX(r.rowid) FROM annotation_revisions r
        JOIN assignments a ON a.id=r.assignment_id WHERE a.task_instance_id=? AND r.status='submitted'),0)
        AND NOT EXISTS(SELECT 1 FROM candidate_vote_results WHERE candidate_set_id=? AND status='accepted')
      ON CONFLICT(candidate_set_id,input_watermark) DO NOTHING`,
          )
          .bind(
            result.id,
            result.candidateSetSnapshotId,
            watermark,
            result.status,
            JSON.stringify(result),
            watermark,
            result.taskInstanceId,
            result.candidateSetSnapshotId,
          )
          .run()
      ).meta.changes === 1
    );
  },
};
