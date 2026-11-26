-- Soft deletion removes work from active boards/queues, preserving source data,
-- Task Instances and immutable annotation revisions for research provenance.
ALTER TABLE annotation_jobs ADD COLUMN deleted_at TEXT;
