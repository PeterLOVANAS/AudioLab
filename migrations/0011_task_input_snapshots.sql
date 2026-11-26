-- C03: pin public dataset input values to the existing Task Instance.
-- Independent of W01's reserved 0010; safe before or after workflow persistence.
-- Existing standalone tasks retain NULL. Old bound tasks require explicit review
-- rather than silently binding historical annotations to today's mutable data.
ALTER TABLE task_instances ADD COLUMN input_snapshot_json TEXT
  CHECK (input_snapshot_json IS NULL OR json_valid(input_snapshot_json));

CREATE TRIGGER task_input_snapshot_immutable
BEFORE UPDATE OF input_snapshot_json ON task_instances
WHEN NEW.input_snapshot_json IS NOT OLD.input_snapshot_json
BEGIN
  SELECT RAISE(ABORT, 'TASK_INPUT_SNAPSHOT_IMMUTABLE');
END;

-- Repointing a bound instance would reinterpret every saved annotation revision.
CREATE TRIGGER task_bound_identity_immutable
BEFORE UPDATE OF project_id, asset_id, source_record_db_id, definition_id, definition_version
ON task_instances
WHEN OLD.input_snapshot_json IS NOT NULL AND (
  NEW.project_id IS NOT OLD.project_id OR NEW.asset_id IS NOT OLD.asset_id OR
  NEW.source_record_db_id IS NOT OLD.source_record_db_id OR
  NEW.definition_id IS NOT OLD.definition_id OR NEW.definition_version IS NOT OLD.definition_version
)
BEGIN
  SELECT RAISE(ABORT, 'TASK_BOUND_IDENTITY_IMMUTABLE');
END;
