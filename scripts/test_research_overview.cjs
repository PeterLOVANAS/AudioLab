/** C08–C09 MVP: allocation API + assignment + annotation services: real services/handlers and SQL on a disposable on-disk SQLite DB.
 * No browser, build, precious state or remote D1. Run: node scripts/test_assignment_allocation.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const ts = require("@typescript/typescript6");
const root = path.resolve(__dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiolab-team-jobs-"));
const filename = path.join(directory, "assignments.sqlite");
let sqlite = new DatabaseSync(filename);
sqlite.exec("PRAGMA foreign_keys=ON");
for (const file of fs
  .readdirSync(path.join(root, "migrations"))
  .filter((file) => file.endsWith(".sql"))
  .sort())
  sqlite.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
const statement = (sql, args = []) => ({
  sql,
  args,
  bind(...values) {
    return statement(sql, values);
  },
  async first() {
    return sqlite.prepare(sql).get(...args) ?? null;
  },
  async all() {
    return { results: sqlite.prepare(sql).all(...args) };
  },
  async run() {
    return { meta: sqlite.prepare(sql).run(...args) };
  },
});
let tail = Promise.resolve();
const db = {
  prepare: statement,
  batch(statements) {
    // Serialize real transactions, matching D1's single-writer behavior. SQL
    // constraints/triggers (not this adapter) decide conflicts and rollbacks.
    const operation = tail.then(() => {
      sqlite.exec("BEGIN");
      try {
        const result = statements.map((s) => ({
          meta: sqlite.prepare(s.sql).run(...s.args),
        }));
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    });
    tail = operation.catch(() => {});
    return operation;
  },
};
const cache = new Map();
function load(relative, dev = true) {
  const key = `${dev}:${relative}`;
  if (cache.has(key)) return cache.get(key).exports;
  const file = path.join(root, relative);
  const output = ts
    .transpileModule(fs.readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    })
    .outputText.replaceAll("import.meta.env.DEV", String(dev));
  const mod = { exports: {} };
  cache.set(key, mod);
  new Function("require", "module", "exports", output)(
    (name) => {
      if (name.endsWith(".css")) return {}; // Node SSR has no stylesheet loader.
      if (name === "cloudflare:workers")
        return { env: { DB: db, AUTH_MODE: "demo" } };
      if (name.startsWith("@/") || name.startsWith(".")) {
        const resolved = name.startsWith("@/")
          ? name.slice(2)
          : path.relative(root, path.resolve(path.dirname(file), name));
        return load(
          resolved +
            (fs.existsSync(path.join(root, resolved + ".ts")) ? ".ts" : ".tsx"),
          dev,
        );
      }
      return require(name);
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}

const { researchOverview } = load("lib/backend/services/research-overview.ts");
const { digest } = load("lib/backend/auth/identity.ts");
const put = (sql, ...args) => sqlite.prepare(sql).run(...args);
const p = crypto.randomUUID(),
  other = crypto.randomUUID(),
  hidden = crypto.randomUUID(),
  dataset = crypto.randomUUID(),
  asset = crypto.randomUUID(),
  asset2 = crypto.randomUUID(),
  definition = crypto.randomUUID();
(async () => {
  for (const [id, name] of [
    [p, "Active"],
    [other, "Setup"],
    [hidden, "Private"],
  ])
    put("INSERT INTO projects(id,name,slug) VALUES(?,?,?)", id, name, id);
  for (const [project, user, role] of [
    [p, "admin", "admin"],
    [other, "admin", "admin"],
    [hidden, "admin", "labeller"],
    [p, "alice", "labeller"],
    [p, "bob", "labeller"],
  ])
    put(
      "INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,?)",
      project,
      user,
      user,
      role,
    );
  put(
    "INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)",
    dataset,
    p,
    "Audio",
    dataset,
  );
  for (const id of [asset, asset2])
    put(
      "INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key) VALUES(?,?,?,'r2',?)",
      id,
      dataset,
      id,
      id,
    );
  put(
    "INSERT INTO task_definitions(id,project_id,draft_json) VALUES(?,?,'{}')",
    definition,
    p,
  );
  put(
    "INSERT INTO task_definition_versions(definition_id,version,definition_json) VALUES(?,1,'{}')",
    definition,
  );
  const instance = (id, key) =>
    put(
      "INSERT INTO task_instances(id,project_id,definition_id,definition_version,asset_id,instance_key) VALUES(?,?,?,1,?,?)",
      id,
      p,
      definition,
      asset,
      key,
    );
  const assign = (id, task, worker, status) =>
    put(
      "INSERT INTO assignments(id,project_id,task_instance_id,labeller_user_id,status) VALUES(?,?,?,?,?)",
      id,
      p,
      task,
      worker,
      status,
    );
  const task = crypto.randomUUID();
  instance(task, "batch");
  put(
    "INSERT INTO task_instance_audio_slots(task_instance_id,slot_index,asset_id) VALUES(?,0,?)",
    task,
    asset,
  );
  put(
    "INSERT INTO task_instance_audio_slots(task_instance_id,slot_index,asset_id) VALUES(?,1,?)",
    task,
    asset2,
  );
  assign("a", task, "alice", "submitted");
  assign("b", task, "bob", "in_progress");
  let result = await researchOverview(db, "admin", p),
    active = result.projects.find((x) => x.id === p);
  assert.equal(result.projects.length, 2);
  assert.equal(active.sourceItems, 2);
  assert.equal(active.completedSourceItems, 0);
  assert.equal(active.assignments, 2);
  assert.equal(active.submitted, 1);
  assert.equal(active.inProgress, 1);
  assert.equal(active.datasets, 1);
  assert.equal(active.audioFiles, 2);
  assert.equal(active.labellers, 2);
  assert.equal(active.status, "active");
  assert.equal(result.projects.find((x) => x.id === other).status, "setup");
  await assert.rejects(
    researchOverview(db, "alice", p),
    (e) => e.status === 403,
  );
  await assert.rejects(
    researchOverview(db, "admin", hidden),
    (e) => e.status === 403,
  );
  put("UPDATE assignments SET status='submitted' WHERE id='b'");
  result = await researchOverview(db, "admin", p);
  assert.equal(result.totals.completedSourceItems, 2);
  // Two batched source items, two workers. The first item anchors both workers;
  // job coverage must expand the second item, including a partial last batch.
  const job = (id, keys, workers, deleted = false) => {
    const plan = {
      batches: [{ itemKeys: keys }],
      pairs: workers.map((w) => ({ itemKey: keys[0], labellerId: w })),
    };
    put(
      "INSERT INTO annotation_jobs(id,project_id,name,dataset_id,definition_id,definition_version,mode,seed,plan_json,plan_hash,created_by,launched_at,deleted_at) VALUES(?,?,?,?,?,1,'voting','seed',?,'hash','admin',CURRENT_TIMESTAMP,?)",
      id,
      p,
      id,
      dataset,
      definition,
      JSON.stringify(plan),
      deleted ? "2026-01-01" : null,
    );
    keys.forEach((key, n) =>
      put(
        "INSERT INTO annotation_job_items(job_id,item_key,asset_id,position) VALUES(?,?,?,?)",
        id,
        key,
        asset,
        n,
      ),
    );
    const task = "task-" + id;
    instance(task, id);
    workers.forEach((worker, n) => {
      put(
        "INSERT INTO annotation_job_workers(job_id,project_id,user_id,profile_json) VALUES(?,?,?,'{}')",
        id,
        p,
        worker,
      );
      const aid = id + n;
      assign(aid, task, worker, n ? "assigned" : "submitted");
      put(
        "INSERT INTO annotation_job_assignments(job_id,assignment_id,item_key) VALUES(?,?,?)",
        id,
        aid,
        keys[0],
      );
    });
  };
  job("campaign1", ["source:q1", "source:q2"], ["alice", "bob"]);
  job("partial", ["source:q3"], ["alice"]);
  job("archived", ["source:secret"], ["alice", "bob"], true);
  job("campaign2", ["source:q1"], ["alice"]);
  result = await researchOverview(db, "admin", p);
  active = result.projects.find((x) => x.id === p);
  assert.equal(active.jobs, 3);
  assert.equal(active.completedJobs, 2);
  assert.equal(active.assignments, 6);
  assert.equal(active.sourceItems, 5);
  assert.equal(active.completedSourceItems, 3); // standalone two + q3
  put("UPDATE assignments SET status='submitted' WHERE id='campaign11'");
  result = await researchOverview(db, "admin", p);
  active = result.projects.find((x) => x.id === p);
  assert.equal(active.completedSourceItems, 5);
  assert.equal(active.status, "complete");
  assert.equal(active.completedJobs, 3);
  // Handler identity is session-derived. Query IDs are never authorization.
  put(
    "INSERT INTO auth_accounts(user_id,username,display_name) VALUES('admin','admin','Admin'),('alice','alice','Alice')",
  );
  const token = "a".repeat(64);
  put(
    "INSERT INTO auth_demo_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
    await digest(token),
    "admin",
    Date.now() + 600000,
  );
  const { GET } = load("app/api/v1/research-overview/route.ts");
  const request = (id, cookie = "") =>
    new Request("http://localhost/api/v1/research-overview?projectId=" + id, {
      headers: { cookie },
    });
  assert.equal((await GET(request(p))).status, 401);
  const ok = await GET(request(p, "audiolab_demo=" + token));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(
    (await GET(request(hidden, "audiolab_demo=" + token))).status,
    403,
  );
  const json = await ok.json();
  assert.equal(
    json.projects.some((x) => x.id === hidden),
    false,
  );
  assert.equal(JSON.stringify(json).includes("source:secret"), false);
  sqlite.close();
  console.log(
    "PASS Overview: aggregate counts, batch/item deduplication, independent assignments, partial batches, archived jobs, scoped admin authorization and authenticated handler. Disposable SQLite: " +
      filename,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
