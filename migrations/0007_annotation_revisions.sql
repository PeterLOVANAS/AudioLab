-- AudioLab 2.0 / Lesson 9
-- Immutable human annotation revisions + assignment status transitions.
--
-- Create a NEW migration for future changes. Never rename this file after it
-- has been applied; D1 tracks migrations by their filenames.
--
-- A revision is ONE saved snapshot, not a mutable answer row. Saving another
-- draft appends revision 2, then 3, etc. This preserves a research audit trail.
-- Original MMAU answers remain in source_labels; we DO NOT copy them here.
CREATE TABLE annotation_revisions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  labeller_user_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitted')),
  answers_json TEXT NOT NULL CHECK (json_valid(answers_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE RESTRICT,
  UNIQUE (assignment_id, revision)
);

CREATE INDEX idx_annotation_revisions_assignment
  ON annotation_revisions(assignment_id, revision DESC);

-- IMPORTANT: Why a database trigger, rather than SELECT + INSERT in JS?
-- Two tabs can save at almost the same time. If both first SELECT revision=2,
-- only ONE is allowed to append revision=3. A BEFORE INSERT trigger evaluates
-- the current revision at the point of the database write (atomic with INSERT).
--
-- SQLite RAISE(ABORT) rolls back the attempted insert. The repository maps
-- these named errors to an HTTP 409 rather than reporting a generic 500.
CREATE TRIGGER annotation_before_insert
BEFORE INSERT ON annotation_revisions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM assignments
    WHERE id = NEW.assignment_id
      AND labeller_user_id = NEW.labeller_user_id
      AND status IN ('assigned', 'in_progress')
  ) THEN RAISE(ABORT, 'ANNOTATION_NOT_WRITABLE') END;

  SELECT CASE WHEN NEW.expected_revision != COALESCE(
    (SELECT MAX(revision) FROM annotation_revisions
     WHERE assignment_id = NEW.assignment_id), 0
  ) THEN RAISE(ABORT, 'ANNOTATION_REVISION_CONFLICT') END;

  SELECT CASE WHEN NEW.revision != NEW.expected_revision + 1
    THEN RAISE(ABORT, 'ANNOTATION_BAD_REVISION_SEQUENCE') END;
END;

-- One database INSERT automatically changes assignment status. The trigger
-- and the INSERT form ONE atomic SQL statement. We cannot end up with a
-- submitted assignment but no submitted answer revision (or vice versa).
CREATE TRIGGER annotation_after_insert
AFTER INSERT ON annotation_revisions
BEGIN
  UPDATE assignments
  SET status = CASE WHEN NEW.status = 'submitted'
                    THEN 'submitted' ELSE 'in_progress' END,
      started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
      submitted_at = CASE WHEN NEW.status = 'submitted'
                          THEN CURRENT_TIMESTAMP ELSE submitted_at END
  WHERE id = NEW.assignment_id;
END;

-- Protect historical human observations against accidental editing/deletion.
-- A future administrator correction must be a NEW explicit event/revision,
-- not a silent UPDATE of the past.
CREATE TRIGGER annotation_no_update
BEFORE UPDATE ON annotation_revisions
BEGIN
  SELECT RAISE(ABORT, 'ANNOTATION_HISTORY_IMMUTABLE');
END;

CREATE TRIGGER annotation_no_delete
BEFORE DELETE ON annotation_revisions
BEGIN
  SELECT RAISE(ABORT, 'ANNOTATION_HISTORY_IMMUTABLE');
END;
