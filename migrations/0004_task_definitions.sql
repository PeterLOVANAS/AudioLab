-- AudioLab 2.0 — Migration 0004: draft definitions and published snapshots.
--
-- IMPORTANT: Migration filenames are saved in D1's migration history.
-- Do not rename, modify, or reapply this file once it is applied. Future
-- changes belong in a NEW migration such as 0005_....sql.
--
-- We deliberately do not put one column per annotation block property.
-- Different research forms need different nested block configurations.
-- Instead, D1 keeps the VALIDATED JSON form definition in a TEXT column.
-- SQLite's json_valid() rejects malformed JSON, but does NOT check the
-- semantic rules for blocks; those are checked by Zod in the API.

CREATE TABLE task_definitions (
  -- Stable identity of the editable protocol across revisions and versions.
  id TEXT PRIMARY KEY,

  -- Definitions belong to a project, not directly to an MMAU dataset.
  project_id TEXT NOT NULL,

  -- JSON text for the current editable draft. Replaced on successful PUT.
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),

  -- Increments whenever the draft is edited. Used for concurrency control.
  -- Starts at 1; an update from rev 1 -> rev 2 must provide expectedRevision=1.
  draft_revision INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision >= 1),

  -- Highest published snapshot version: 0 means never published.
  -- Increments only when POST /publish succeeds.
  published_version INTEGER NOT NULL DEFAULT 0 CHECK (published_version >= 0),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Prevent orphaned definitions from pointing to non-existent projects.
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

-- Makes `WHERE project_id = ?` listings more efficient as projects grow.
CREATE INDEX idx_task_definitions_project
  ON task_definitions(project_id);

-- Published versions are stored as separate rows so that editing a draft
-- cannot rewrite historical annotation protocols.
CREATE TABLE task_definition_versions (
  definition_id TEXT NOT NULL,

  -- 1, 2, 3... Published versions are different from draft revisions.
  version INTEGER NOT NULL CHECK (version >= 1),

  -- Frozen JSON snapshot of the definition at publish time.
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Two pieces of identity: one definition can have version 1 AND version 2,
  -- but never two separate rows for (definition_id, version=1).
  PRIMARY KEY (definition_id, version),

  -- Do not delete the parent while published snapshots depend on it.
  FOREIGN KEY (definition_id) REFERENCES task_definitions(id) ON DELETE RESTRICT
);
