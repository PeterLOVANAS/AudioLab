-- Additive, read-optimized index for the labeller's pending queue.
-- The partial index avoids indexing completed/reviewed assignments.
-- Only apply if migration numbers 0001-0008 are present and 0009 unused.
CREATE INDEX IF NOT EXISTS idx_assignments_labeller_active_queue
ON assignments (project_id, labeller_user_id, assigned_at, id)
WHERE status IN ('assigned', 'in_progress');
