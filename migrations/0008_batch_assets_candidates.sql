-- AudioLab v4 — append-only schema migration. NEVER rewrite applied migrations.
-- This links one Task Instance to a stable ORDERED batch of WAVs (R2 assets)
-- and stores curated candidate labels separately from private MMAU ground truth.
CREATE TABLE task_instance_audio_slots (
  task_instance_id TEXT NOT NULL REFERENCES task_instances(id) ON DELETE RESTRICT,
  slot_index INTEGER NOT NULL CHECK(slot_index BETWEEN 0 AND 23),
  asset_id TEXT NOT NULL REFERENCES audio_assets(id) ON DELETE RESTRICT,
  PRIMARY KEY(task_instance_id,slot_index),
  UNIQUE(task_instance_id,asset_id)
);
CREATE INDEX idx_task_instance_audio_slots_asset ON task_instance_audio_slots(asset_id);

-- Candidate Vote must NEVER SELECT source_labels.kind='reference_answer'.
-- A researcher may explicitly curate a candidate from a model prediction,
-- earlier annotation, or imported spreadsheet for BLIND human review.
CREATE TABLE annotation_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL REFERENCES audio_assets(id) ON DELETE RESTRICT,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 4000),
  provenance TEXT NOT NULL CHECK(provenance IN ('model','researcher','early_annotation')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_annotation_candidates_asset ON annotation_candidates(asset_id,created_at);
