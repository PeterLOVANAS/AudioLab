-- C04: immutable eligible candidate groups. Votes stay in annotation_revisions.
-- Independent of W01's reserved 0010 and additive to existing curated candidates.
CREATE TABLE candidate_set_snapshots (
  id TEXT PRIMARY KEY,
  task_instance_id TEXT NOT NULL REFERENCES task_instances(id) ON DELETE RESTRICT,
  block_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_by TEXT NOT NULL,
  entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 2 AND 20),
  allow_self_vote INTEGER NOT NULL CHECK (allow_self_vote IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_instance_id, block_id)
);

CREATE TABLE candidate_set_entries (
  id TEXT PRIMARY KEY,
  candidate_set_id TEXT NOT NULL REFERENCES candidate_set_snapshots(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 19),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('dataset_annotation','submission','curated')),
  source_label_id TEXT REFERENCES source_labels(id) ON DELETE RESTRICT,
  source_revision_id TEXT REFERENCES annotation_revisions(id) ON DELETE RESTRICT,
  curated_candidate_id TEXT REFERENCES annotation_candidates(id) ON DELETE RESTRICT,
  source_field_id TEXT NOT NULL,
  source_record_db_id TEXT REFERENCES source_records(id) ON DELETE RESTRICT,
  source_task_instance_id TEXT REFERENCES task_instances(id) ON DELETE RESTRICT,
  source_definition_id TEXT,
  source_definition_version INTEGER,
  source_author_id TEXT,
  source_updated_at TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  FOREIGN KEY(source_definition_id,source_definition_version)
    REFERENCES task_definition_versions(definition_id,version) ON DELETE RESTRICT,
  UNIQUE(candidate_set_id,position),
  CHECK (
    (source_kind='dataset_annotation' AND source_label_id IS NOT NULL AND
      source_record_db_id IS NOT NULL AND source_revision_id IS NULL AND curated_candidate_id IS NULL) OR
    (source_kind='submission' AND source_revision_id IS NOT NULL AND
      source_task_instance_id IS NOT NULL AND source_definition_id IS NOT NULL AND
      source_definition_version IS NOT NULL AND source_author_id IS NOT NULL AND
      source_label_id IS NULL AND curated_candidate_id IS NULL) OR
    (source_kind='curated' AND curated_candidate_id IS NOT NULL AND
      source_label_id IS NULL AND source_revision_id IS NULL)
  )
);

CREATE INDEX idx_candidate_entries_set ON candidate_set_entries(candidate_set_id,position);
CREATE TRIGGER candidate_set_no_update BEFORE UPDATE ON candidate_set_snapshots
BEGIN SELECT RAISE(ABORT,'CANDIDATE_SET_IMMUTABLE'); END;
CREATE TRIGGER candidate_set_no_delete BEFORE DELETE ON candidate_set_snapshots
BEGIN SELECT RAISE(ABORT,'CANDIDATE_SET_IMMUTABLE'); END;
CREATE TRIGGER candidate_entry_no_update BEFORE UPDATE ON candidate_set_entries
BEGIN SELECT RAISE(ABORT,'CANDIDATE_SET_IMMUTABLE'); END;
CREATE TRIGGER candidate_entry_no_delete BEFORE DELETE ON candidate_set_entries
BEGIN SELECT RAISE(ABORT,'CANDIDATE_SET_IMMUTABLE'); END;

-- A complete set occupies every allowed position. Immutability + this bound
-- prevents later INSERTs from growing a published candidate snapshot.
CREATE TRIGGER candidate_entry_position_guard BEFORE INSERT ON candidate_set_entries
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM candidate_set_snapshots
    WHERE id=NEW.candidate_set_id AND NEW.position < entry_count)
    THEN RAISE(ABORT,'CANDIDATE_SET_CONTENT_INVALID') END;
END;

CREATE TRIGGER candidate_task_identity_immutable
BEFORE UPDATE OF project_id,asset_id,source_record_db_id,definition_id,definition_version ON task_instances
WHEN EXISTS(SELECT 1 FROM candidate_set_snapshots WHERE task_instance_id=OLD.id) AND (
  NEW.project_id IS NOT OLD.project_id OR NEW.asset_id IS NOT OLD.asset_id OR
  NEW.source_record_db_id IS NOT OLD.source_record_db_id OR NEW.definition_id IS NOT OLD.definition_id OR
  NEW.definition_version IS NOT OLD.definition_version
)
BEGIN SELECT RAISE(ABORT,'CANDIDATE_TASK_IDENTITY_IMMUTABLE'); END;
