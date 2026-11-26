-- Additive canonical metadata; existing legacy imports remain readable.
ALTER TABLE source_records ADD COLUMN canonical_json TEXT CHECK(canonical_json IS NULL OR json_valid(canonical_json));
ALTER TABLE source_records ADD COLUMN ingestion_hash TEXT;
CREATE TRIGGER canonical_source_immutable BEFORE UPDATE ON source_records
WHEN OLD.ingestion_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT,'CANONICAL_SOURCE_IMMUTABLE'); END;
-- NULL identifies legacy imports. Allow legacy-to-legacy upserts, but never
-- let either path replace a canonical identity or adopt an existing legacy row.
CREATE TRIGGER canonical_source_conflict BEFORE INSERT ON source_records
WHEN EXISTS(SELECT 1 FROM source_records s WHERE s.asset_id=NEW.asset_id AND s.source_record_id=NEW.source_record_id
 AND s.ingestion_hash IS NOT NEW.ingestion_hash)
BEGIN SELECT RAISE(ABORT,'CANONICAL_SOURCE_CONFLICT'); END;
CREATE TRIGGER canonical_label_immutable BEFORE UPDATE ON source_labels
WHEN EXISTS(SELECT 1 FROM source_records s WHERE s.id=OLD.source_record_id AND s.ingestion_hash IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'CANONICAL_LABEL_IMMUTABLE'); END;
ALTER TABLE source_records ADD COLUMN canonical_dataset_id TEXT REFERENCES datasets(id);
CREATE UNIQUE INDEX canonical_item_identity ON source_records(canonical_dataset_id,
 json_extract(canonical_json,'$.sample_id'),json_extract(canonical_json,'$.item_id'),json_extract(canonical_json,'$.source_version'))
 WHERE ingestion_hash IS NOT NULL;
-- Protect sample identity even when concurrent batches introduce different items.
CREATE TRIGGER canonical_sample_conflict BEFORE INSERT ON source_records
WHEN NEW.ingestion_hash IS NOT NULL AND EXISTS(
 SELECT 1 FROM source_records s WHERE s.canonical_dataset_id=NEW.canonical_dataset_id
 AND json_extract(s.canonical_json,'$.sample_id')=json_extract(NEW.canonical_json,'$.sample_id')
 AND json_extract(s.canonical_json,'$.source_version')=json_extract(NEW.canonical_json,'$.source_version')
 AND (s.asset_id<>NEW.asset_id OR json_extract(s.canonical_json,'$.sample_fields')<>json_extract(NEW.canonical_json,'$.sample_fields')
 OR json_extract(s.canonical_json,'$.metadata')<>json_extract(NEW.canonical_json,'$.metadata'))
)
BEGIN SELECT RAISE(ABORT,'CANONICAL_SOURCE_SAMPLE_CONFLICT'); END;
