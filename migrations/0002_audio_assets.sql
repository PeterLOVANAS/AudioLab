
-- AudioLab 2.0
-- Migration 0002: Audio Asset Registry
--
-- Each asset refers to a recording registered
-- within a dataset.
--
-- Audio bytes are stored separately in R2
-- or another storage provider.

CREATE TABLE audio_assets (
    id TEXT PRIMARY KEY,

    -- Parent dataset.
    dataset_id TEXT NOT NULL,

    -- Original filename/path from the source dataset.
    original_path TEXT NOT NULL,

    -- Actual storage location.
    storage_provider TEXT NOT NULL
        CHECK (storage_provider IN ('local', 'r2', 's3')),

    storage_key TEXT NOT NULL,

    -- Optional source metadata.
    source_dataset TEXT,
    source_record_id TEXT,
    source_domain TEXT,
    split TEXT,

    -- Audio properties.
    mime_type TEXT,
    size_bytes INTEGER
        CHECK (size_bytes IS NULL OR size_bytes >= 0),

    duration_seconds REAL
        CHECK (duration_seconds IS NULL OR duration_seconds >= 0),

    sample_rate INTEGER
        CHECK (sample_rate IS NULL OR sample_rate > 0),

    channels INTEGER
        CHECK (channels IS NULL OR channels > 0),

    sha256 TEXT,

    created_at TEXT NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    -- Every registered audio asset belongs to
    -- an existing dataset.
    FOREIGN KEY (dataset_id)
        REFERENCES datasets(id)
        ON DELETE RESTRICT,

    -- Do not register the same source path
    -- twice within one dataset.
    UNIQUE (dataset_id, original_path)
);

-- Speeds up retrieval of assets for one dataset.
CREATE INDEX idx_audio_assets_dataset
ON audio_assets(dataset_id);
