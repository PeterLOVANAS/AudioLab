-- AudioLab 2.0 — Lesson 8: project membership and labeller assignments.
--
-- KEEP THIS FILENAME IMMUTABLE AFTER APPLYING IT.
-- D1 migration history is keyed by the filename; renaming an applied file
-- can cause the migration tool to try to create these tables again.
--
-- This is intentionally NOT an authentication system. During local
-- development, we register dev identities so the database can validate
-- relationships. In a deployed app, identity must come from a verified
-- session/token, not the userId or labellerId supplied by a browser.

CREATE TABLE project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'labeller')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Composite primary key: a user belongs to a given project at most once.
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

-- Useful when building an admin member list or a labeller picker.
CREATE INDEX idx_project_members_project_role
  ON project_members(project_id, role, display_name);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_instance_id TEXT NOT NULL,
  labeller_user_id TEXT NOT NULL,

  -- Start with 'assigned'. Lessons 9+ will move a task to submitted/reviewed
  -- ONLY after a validated annotation submission/review is saved.
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned', 'in_progress', 'submitted', 'reviewed')),

  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  submitted_at TEXT,
  reviewed_at TEXT,

  -- Prevent assigning the SAME task to the SAME person more than once.
  -- Different labellers may independently annotate the same task.
  UNIQUE (task_instance_id, labeller_user_id),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  FOREIGN KEY (task_instance_id) REFERENCES task_instances(id) ON DELETE RESTRICT,

  -- Composite FK: the assigned labeller MUST belong to this project.
  -- The service additionally checks that the member's role is 'labeller'.
  FOREIGN KEY (project_id, labeller_user_id)
    REFERENCES project_members(project_id, user_id) ON DELETE RESTRICT
);

-- Fast query: show a project's assignments in the admin dashboard.
CREATE INDEX idx_assignments_project_status
  ON assignments(project_id, status, assigned_at);

-- Fast query: show one labeller's assigned/in-progress tasks.
CREATE INDEX idx_assignments_labeller_queue
  ON assignments(project_id, labeller_user_id, status, assigned_at);
