-- C05: immutable aggregate observations; an accepted result seals voting.
-- Independent of reserved W01 0010; depends on C04 0012.
CREATE TABLE candidate_vote_results (
  id TEXT PRIMARY KEY,
  candidate_set_id TEXT NOT NULL REFERENCES candidate_set_snapshots(id) ON DELETE RESTRICT,
  input_watermark INTEGER NOT NULL CHECK(input_watermark >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending_votes','pending_adjudication','accepted')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(candidate_set_id,input_watermark)
);
CREATE UNIQUE INDEX idx_candidate_result_accepted ON candidate_vote_results(candidate_set_id) WHERE status='accepted';
CREATE TRIGGER candidate_result_no_update BEFORE UPDATE ON candidate_vote_results
BEGIN SELECT RAISE(ABORT,'CANDIDATE_RESULT_IMMUTABLE'); END;
CREATE TRIGGER candidate_result_no_delete BEFORE DELETE ON candidate_vote_results
BEGIN SELECT RAISE(ABORT,'CANDIDATE_RESULT_IMMUTABLE'); END;

-- This guard shares the SQLite write boundary with result finalization. A
-- concurrent vote either precedes the result watermark or is rejected after
-- acceptance. CASE avoids json_extract on scalar text answers in other blocks.
CREATE TRIGGER candidate_vote_closed BEFORE INSERT ON annotation_revisions
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.answers_json) j
  JOIN candidate_set_snapshots s ON s.block_id=j.key
  JOIN candidate_vote_results result ON result.candidate_set_id=s.id AND result.status='accepted'
  JOIN assignments a ON a.id=NEW.assignment_id AND a.task_instance_id=s.task_instance_id
  WHERE s.id=json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.candidateSetSnapshotId')
)
BEGIN SELECT RAISE(ABORT,'CANDIDATE_VOTING_CLOSED'); END;
