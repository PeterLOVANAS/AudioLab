-- Additive team jobs and explicit authenticated identity links. W01/0010 stays reserved.
CREATE TABLE auth_accounts (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  demo_salt TEXT,
  demo_password_hash TEXT,
  CHECK((demo_salt IS NULL) = (demo_password_hash IS NULL))
);
CREATE TABLE auth_identity_links (
  issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL,
  PRIMARY KEY(issuer,subject), FOREIGN KEY(user_id) REFERENCES auth_accounts(user_id) ON DELETE RESTRICT
);
CREATE TABLE auth_demo_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES auth_accounts(user_id) ON DELETE CASCADE
);
CREATE INDEX auth_demo_sessions_expiry ON auth_demo_sessions(expires_at);
CREATE TABLE auth_login_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);
CREATE TABLE worker_profiles (
  project_id TEXT NOT NULL, user_id TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '', profession TEXT NOT NULL DEFAULT '',
  languages_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(languages_json)),
  experience_years INTEGER NOT NULL DEFAULT 0 CHECK(experience_years>=0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  PRIMARY KEY(project_id,user_id),
  FOREIGN KEY(project_id,user_id) REFERENCES project_members(project_id,user_id) ON DELETE RESTRICT
);
CREATE TABLE worker_teams (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id,name), FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT
);
CREATE TABLE worker_team_members (
  team_id TEXT NOT NULL, project_id TEXT NOT NULL,user_id TEXT NOT NULL,
  PRIMARY KEY(team_id,user_id),
  FOREIGN KEY(team_id) REFERENCES worker_teams(id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,user_id) REFERENCES project_members(project_id,user_id) ON DELETE RESTRICT
);
CREATE TRIGGER team_member_scope BEFORE INSERT ON worker_team_members
WHEN NOT EXISTS(SELECT 1 FROM worker_teams t JOIN project_members m ON m.project_id=t.project_id
  WHERE t.id=NEW.team_id AND t.project_id=NEW.project_id AND m.user_id=NEW.user_id AND m.role='labeller')
BEGIN SELECT RAISE(ABORT,'TEAM_MEMBER_SCOPE'); END;
CREATE TABLE annotation_jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, team_id TEXT,
  dataset_id TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('individual','voting')),
  seed TEXT NOT NULL, plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  plan_hash TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  launched_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE RESTRICT,
  FOREIGN KEY(definition_id,definition_version) REFERENCES task_definition_versions(definition_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(team_id) REFERENCES worker_teams(id) ON DELETE RESTRICT
);
CREATE TABLE annotation_job_items (
  job_id TEXT NOT NULL, item_key TEXT NOT NULL, asset_id TEXT NOT NULL, source_record_id TEXT,
  position INTEGER NOT NULL,
  PRIMARY KEY(job_id,item_key), UNIQUE(job_id,position),
  FOREIGN KEY(job_id) REFERENCES annotation_jobs(id) ON DELETE RESTRICT,
  FOREIGN KEY(asset_id) REFERENCES audio_assets(id) ON DELETE RESTRICT,
  FOREIGN KEY(source_record_id) REFERENCES source_records(id) ON DELETE RESTRICT
);
CREATE TABLE annotation_job_workers (
  job_id TEXT NOT NULL, project_id TEXT NOT NULL,user_id TEXT NOT NULL, profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  PRIMARY KEY(job_id,user_id), FOREIGN KEY(job_id) REFERENCES annotation_jobs(id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,user_id) REFERENCES project_members(project_id,user_id) ON DELETE RESTRICT
);
CREATE TABLE annotation_job_assignments (
  job_id TEXT NOT NULL, assignment_id TEXT NOT NULL UNIQUE, item_key TEXT NOT NULL,
  PRIMARY KEY(job_id,assignment_id),
  FOREIGN KEY(job_id,item_key) REFERENCES annotation_job_items(job_id,item_key) ON DELETE RESTRICT,
  FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON DELETE RESTRICT
);
CREATE TRIGGER job_plan_immutable BEFORE UPDATE ON annotation_jobs
WHEN NEW.plan_json IS NOT OLD.plan_json OR NEW.plan_hash IS NOT OLD.plan_hash OR
 NEW.project_id IS NOT OLD.project_id OR NEW.dataset_id IS NOT OLD.dataset_id OR
 NEW.definition_id IS NOT OLD.definition_id OR NEW.definition_version IS NOT OLD.definition_version OR
 NEW.mode IS NOT OLD.mode OR NEW.seed IS NOT OLD.seed OR NEW.team_id IS NOT OLD.team_id
BEGIN SELECT RAISE(ABORT,'JOB_PLAN_IMMUTABLE'); END;
CREATE TRIGGER job_assignment_scope BEFORE INSERT ON annotation_job_assignments
WHEN NOT EXISTS(SELECT 1 FROM assignments a JOIN task_instances i ON i.id=a.task_instance_id
 JOIN annotation_jobs j ON j.id=NEW.job_id JOIN annotation_job_items item ON item.job_id=j.id AND item.item_key=NEW.item_key
 JOIN annotation_job_workers w ON w.job_id=j.id AND w.user_id=a.labeller_user_id
 WHERE a.id=NEW.assignment_id AND a.project_id=j.project_id AND i.project_id=j.project_id AND i.definition_id=j.definition_id
 AND i.definition_version=j.definition_version AND i.asset_id=item.asset_id
 AND i.source_record_db_id IS item.source_record_id)
BEGIN SELECT RAISE(ABORT,'JOB_ASSIGNMENT_SCOPE'); END;
