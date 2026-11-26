-- AudioLab 2.0 / migration 0003
-- Preserve imported QA and pre-existing labels separately from Labeller submissions.
-- This does NOT create task/assignment/annotation-revision tables.

CREATE TABLE source_records (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES audio_assets(id) ON DELETE RESTRICT,
  source_record_id TEXT NOT NULL,
  source_domain TEXT NOT NULL CHECK (source_domain IN ('sound','speech','music','unknown')),
  question TEXT,
  choices_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(asset_id, source_record_id)
);

CREATE INDEX idx_source_records_asset ON source_records(asset_id);

CREATE TABLE source_labels (
  id TEXT PRIMARY KEY,
  source_record_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('reference_answer','early_annotation')),
  payload_json TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_record_id, kind)
);

CREATE INDEX idx_source_labels_record ON source_labels(source_record_id);
