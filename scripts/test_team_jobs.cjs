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
const { taskDefinitionService: definitions } = load(
  "lib/backend/services/task-definitions.ts",
);
const { assignmentService: assignments } = load(
  "lib/backend/services/assignments.ts",
);
const { annotationService: annotations } = load(
  "lib/backend/services/annotations.ts",
);
const { ingestDataset } = load("lib/backend/services/dataset-ingestion.ts");
const { taskDraftSchema } = load("lib/backend/validation/task-definitions.ts");
const { jobInputSchema } = load("lib/backend/validation/team-jobs.ts");
const { buildJobPlan, launchJob, jobDetail, jobSummaries } = load(
  "lib/backend/services/team-jobs.ts",
);
const { jobResults } = load("lib/backend/services/job-results.ts");
const { digest, demoPasswordHash, authenticate, verifyAccessToken } = load(
  "lib/backend/auth/identity.ts",
);
const { authorizeApi } = load("lib/backend/auth/api-guard.ts");
const project = crypto.randomUUID(),
  dataset = crypto.randomUUID(),
  audio = crypto.randomUUID(),
  other = crypto.randomUUID();
const actor = "admin",
  workers = ["alice", "bob", "chai"];
const settings = { AUTH_MODE: "demo" };
let cookie = "";
const req = (path, method = "GET", body) =>
  new Request("http://localhost/api/v1/" + path, {
    method,
    headers: {
      cookie,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
(async () => {
  sqlite
    .prepare("INSERT INTO projects(id,name,slug) VALUES(?,?,?)")
    .run(project, "Team test", project);
  sqlite
    .prepare("INSERT INTO projects(id,name,slug) VALUES(?,?,?)")
    .run(other, "Other", other);
  sqlite
    .prepare("INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)")
    .run(dataset, project, "Items", "1");
  sqlite
    .prepare(
      "INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key) VALUES(?,?,?,'r2',?)",
    )
    .run(audio, dataset, "tone.wav", "tone.wav");
  for (const [user, role] of [
    [actor, "admin"],
    ...workers.map((w) => [w, "labeller"]),
  ]) {
    await assignments.addMember(db, {
      projectId: project,
      userId: user,
      displayName: user,
      role,
    });
    sqlite
      .prepare(
        "INSERT INTO auth_accounts(user_id,username,display_name,demo_salt,demo_password_hash) VALUES(?,?,?,?,?)",
      )
      .run(
        user,
        user,
        user,
        "salt",
        await demoPasswordHash("test-password-only", "salt"),
      );
    if (role === "labeller")
      sqlite
        .prepare(
          "INSERT INTO worker_profiles(project_id,user_id,country,profession) VALUES(?,?,?,?)",
        )
        .run(project, user, user === "chai" ? "Japan" : "Thailand", "Linguist");
  }
  const field = (value) => ({ type: "text", value, visibility: "worker" });
  const payload = {
    schema_version: 1,
    dataset_id: dataset,
    source_version: "v1",
    provenance: { origin: "test", revision: "1" },
    records: [
      {
        sample_id: "sample",
        audio_id: audio,
        fields: { instructions: field("Independent instructions") },
        items: Array.from({ length: 10 }, (_, i) => ({
          item_id: "q" + i,
          fields: {
            question: field("Question " + i),
            options: {
              type: "choices",
              visibility: "worker",
              value: [
                { id: "a", label: "Alpha" },
                { id: "b", label: "Beta" },
              ],
            },
          },
        })),
      },
    ],
  };
  const imported = await ingestDataset(db, project, actor, payload, true);
  assert(imported.ok);
  const draft = taskDraftSchema.parse({
    name: "Classification",
    description: "",
    domain: "sound",
    instructions: "fallback",
    instructionBinding: {
      kind: "dataset",
      fieldId: "sample.instructions",
      type: "string",
    },
    policy: {
      requiredIndependentVotes: 1,
      blindToOthers: true,
      requiresReview: false,
    },
    blocks: [
      {
        id: "answer",
        type: "single_choice",
        label: "Question",
        required: true,
        sourceBindings: {
          label: { kind: "dataset", fieldId: "item.question", type: "string" },
          options: {
            kind: "dataset",
            fieldId: "item.options",
            type: "choices",
          },
        },
      },
    ],
  });
  const def = await definitions.create(db, project, draft);
  await definitions.publish(db, def.id, 1, 0);
  const input = jobInputSchema.parse({
    jobId: crypto.randomUUID(),
    projectId: project,
    name: "Partition",
    datasetId: dataset,
    definitionId: def.id,
    definitionVersion: 1,
    mode: "individual",
    seed: "repeatable",
    itemKeys: imported.accepted.map((row) => row.id),
    workerIds: ["chai", "alice", "bob"],
    sampleCount: 10,
  });
  const p = await buildJobPlan(db, actor, input);
  assert.deepEqual(Object.values(p.counts).sort(), [3, 3, 4]);
  assert.equal(new Set(p.pairs.map((pair) => pair.itemKey)).size, 10);
  assert.equal(
    (
      await buildJobPlan(db, actor, {
        ...input,
        workerIds: [...input.workerIds].reverse(),
        itemKeys: [...input.itemKeys].reverse(),
      })
    ).hash,
    p.hash,
  );
  assert.notDeepEqual(
    (await buildJobPlan(db, actor, { ...input, seed: "another" })).items.map(
      (item) => item.key,
    ),
    p.items.map((item) => item.key),
  );
  const detail = await launchJob(db, actor, p.input, p.hash);
  assert.equal(detail.assignments.length, 10);
  assert.equal(
    (await launchJob(db, actor, p.input, p.hash)).assignments.length,
    10,
  );
  const vote = await buildJobPlan(db, actor, {
    ...input,
    jobId: crypto.randomUUID(),
    name: "Voting",
    mode: "voting",
    workerIds: ["bob", "alice"],
  });
  const voted = await launchJob(db, actor, vote.input, vote.hash);
  assert.equal(voted.assignments.length, 20);
  for (const user of ["alice", "bob"])
    assert.deepEqual(
      voted.assignments
        .filter((a) => a.userId === user)
        .map((a) => a.itemKey)
        .sort(),
      vote.items.map((item) => item.key).sort(),
    );
  assert.equal((await jobResults(db, actor, vote.input.jobId)).complete, false);
  for (const a of voted.assignments) {
    await annotations.save(
      db,
      a.id,
      {
        labellerId: a.userId,
        expectedRevision: 0,
        answers: { answer: a.userId === "alice" ? "a" : "b" },
      },
      "submitted",
    );
  }
  const result = await jobResults(db, actor, vote.input.jobId);
  assert(result.complete);
  assert.equal(result.blocks[0].meanSimilarity, 0);
  assert.equal(result.blocks[0].validComparisons, 10);
  assert.equal(
    result.blocks[0].counts.reduce((n, c) => n + c.count, 0),
    20,
  );
  assert.equal(
    (await jobDetail(db, actor, vote.input.jobId)).summary.fullyLabelledItems,
    10,
  );
  // Job isolation: a new team job can ask the same people to label the same items
  // without replacing their prior assignments/revisions or reusing old answers.
  assert.equal(
    new Set([...detail.assignments, ...voted.assignments].map((a) => a.id))
      .size,
    30,
  );
  sqlite
    .prepare(
      "UPDATE worker_profiles SET active=0,country='Changed' WHERE project_id=? AND user_id='alice'",
    )
    .run(project);
  assert.equal(
    (await launchJob(db, actor, vote.input, vote.hash)).assignments.length,
    20,
  );
  assert.equal(
    (await jobDetail(db, actor, vote.input.jobId)).plan.workers.find(
      (w) => w.userId === "alice",
    ).country,
    "Thailand",
  );
  await assert.rejects(
    buildJobPlan(db, actor, { ...input, jobId: crypto.randomUUID() }),
    /active/,
  );
  sqlite
    .prepare("UPDATE worker_profiles SET active=1 WHERE project_id=?")
    .run(project);
  await assert.rejects(
    launchJob(db, actor, { ...vote.input, name: "tampered" }, vote.hash),
    /configuration/,
  );
  await assert.rejects(buildJobPlan(db, "alice", input), /admin/);
  await assert.rejects(
    buildJobPlan(db, actor, { ...input, datasetId: crypto.randomUUID() }),
    /Dataset/,
  );
  // Sessions and API scope: no role toggle or request actor can impersonate Bob.
  const token = "a".repeat(64);
  await db
    .prepare(
      "INSERT INTO auth_demo_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
    )
    .bind(await digest(token), "alice", Date.now() + 60000)
    .run();
  cookie = "audiolab_demo=" + token;
  assert.equal(
    (await authenticate(db, req("auth/session"), settings)).userId,
    "alice",
  );
  assert.equal(
    (
      await authorizeApi(
        db,
        req("labeller/assigned-queue?projectId=" + project + "&labellerId=bob"),
        settings,
      )
    ).status,
    403,
  );
  assert.equal(
    (await authorizeApi(db, req("team-jobs?projectId=" + project), settings))
      .status,
    403,
  );
  assert.equal(
    (
      await authorizeApi(
        db,
        req("worker-profiles?projectId=" + project, "POST", {
          projectId: project,
          userId: "alice",
        }),
        settings,
      )
    ).status,
    403,
  );
  const own = voted.assignments.find((a) => a.userId === "alice"),
    peer = voted.assignments.find((a) => a.userId === "bob");
  assert.equal(
    await authorizeApi(db, req("assignments/" + own.id), settings),
    null,
  );
  assert.equal(
    (await authorizeApi(db, req("assignments/" + peer.id), settings)).status,
    403,
  );
  assert.equal(
    (
      await authorizeApi(
        db,
        req("assignments/" + own.id + "/annotation/submit", "POST", {
          labellerId: "bob",
        }),
        settings,
      )
    ).status,
    403,
  );
  assert.equal(
    (await authorizeApi(db, req("datasets?projectId=" + other), settings))
      .status,
    403,
  );
  cookie = "";
  assert.equal((await authorizeApi(db, req("projects"), settings)).status, 401);
  assert.equal(
    (
      await authenticate(db, req("auth/session"), {
        AUTH_MODE: "access",
      }).catch((e) => e)
    ).status,
    503,
  );
  const jose = require("jose"),
    { privateKey, publicKey } = await jose.generateKeyPair("RS256");
  const issuer = "https://test.cloudflareaccess.com",
    audience = "test-audience",
    resolver = async () => publicKey;
  const jwt = await new jose.SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("external-subject")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  assert.equal(
    await verifyAccessToken(jwt, issuer, audience, resolver),
    "external-subject",
  );
  await assert.rejects(
    verifyAccessToken(jwt, issuer, "wrong-audience", resolver),
  );
  await assert.rejects(
    verifyAccessToken(
      jwt,
      "https://other.cloudflareaccess.com",
      audience,
      resolver,
    ),
  );
  const expired = await new jose.SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("external-subject")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(1)
    .setExpirationTime(2)
    .sign(privateKey);
  await assert.rejects(verifyAccessToken(expired, issuer, audience, resolver));
  // Grounding statistics use real interval submissions and report no score
  // until both selected workers have submitted, never fabricated 100% IoU.
  const ground = {
    ...draft,
    name: "Grounding",
    instructionBinding: undefined,
    blocks: [
      {
        id: "ground",
        type: "timeline_annotation",
        label: "Events",
        required: true,
        groundingMode: "sound",
        tiers: [
          {
            id: "events",
            name: "Events",
            kind: "interval",
            labelMode: "text",
            allowOverlap: true,
          },
        ],
      },
    ],
  };
  const groundDef = await definitions.create(
    db,
    project,
    taskDraftSchema.parse(ground),
  );
  await definitions.publish(db, groundDef.id, 1, 0);
  const gp = await buildJobPlan(db, actor, {
    ...input,
    jobId: crypto.randomUUID(),
    definitionId: groundDef.id,
    mode: "voting",
    workerIds: ["alice", "bob"],
    sampleCount: 1,
  });
  const gj = await launchJob(db, actor, gp.input, gp.hash);
  for (const [index, a] of gj.assignments.entries()) {
    await annotations.save(
      db,
      a.id,
      {
        labellerId: a.userId,
        expectedRevision: 0,
        answers: {
          ground: {
            tiers: {
              events: [
                {
                  id: "event",
                  start: index * 0.5,
                  end: 1 + index * 0.5,
                  text: "tone",
                },
              ],
            },
          },
        },
      },
      "submitted",
    );
    if (index === 0)
      assert.equal(
        (await jobResults(db, actor, gp.input.jobId)).complete,
        false,
      );
  }
  const gr = await jobResults(db, actor, gp.input.jobId);
  assert(gr.complete);
  assert(Math.abs(gr.blocks[0].meanSimilarity - 1 / 3) < 1e-9);
  const teamId = crypto.randomUUID();
  sqlite
    .prepare(
      "INSERT INTO worker_teams(id,project_id,name,created_by) VALUES(?,?,?,?)",
    )
    .run(teamId, project, "Original team", actor);
  for (const user of ["alice", "bob"])
    sqlite
      .prepare(
        "INSERT INTO worker_team_members(team_id,project_id,user_id) VALUES(?,?,?)",
      )
      .run(teamId, project, user);
  const tp = await buildJobPlan(db, actor, {
    ...input,
    jobId: crypto.randomUUID(),
    teamId,
    workerIds: ["bob", "alice"],
    sampleCount: 2,
  });
  const tj = await launchJob(db, actor, tp.input, tp.hash);
  sqlite
    .prepare("DELETE FROM worker_team_members WHERE team_id=? AND user_id=?")
    .run(teamId, "bob");
  sqlite
    .prepare("UPDATE worker_teams SET name='Renamed' WHERE id=?")
    .run(teamId);
  assert.equal(
    (await jobDetail(db, actor, tp.input.jobId)).plan.workers.length,
    2,
  );
  assert.equal(
    (await jobDetail(db, actor, tp.input.jobId)).summary.teamName,
    "Original team",
  );
  await assert.rejects(
    buildJobPlan(db, actor, { ...tp.input, jobId: crypto.randomUUID() }),
    /belong/,
  );
  const login = load("app/api/v1/auth/login/route.ts"),
    logout = load("app/api/v1/auth/logout/route.ts");
  const logged = await login.POST(
    req("auth/login", "POST", {
      username: "alice",
      password: "test-password-only",
    }),
  );
  assert.equal(logged.status, 200);
  cookie = logged.headers.get("set-cookie").split(";")[0];
  assert(logged.headers.get("set-cookie").includes("HttpOnly"));
  assert(logged.headers.get("set-cookie").includes("SameSite=Strict"));
  assert.equal(
    (await authenticate(db, req("auth/session"), settings)).userId,
    "alice",
  );
  assert.equal((await logout.POST(req("auth/logout", "POST"))).status, 200);
  await assert.rejects(
    authenticate(db, req("auth/session"), settings),
    /Login/,
  );
  const forged = await new jose.SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("external-subject")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign((await jose.generateKeyPair("RS256")).privateKey);
  await assert.rejects(verifyAccessToken(forged, issuer, audience, resolver));
  console.log(
    "PASS temporal IoU 1/3 from actual final interval answers, completion gate, team membership/name snapshot preservation, demo cookie and logout revocation",
  );
  const accessSettings = {
    AUTH_MODE: "access",
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUDIENCE: audience,
    APP_ORIGIN: "https://audio.example",
  };
  const accessRequest = new Request("https://audio.example/api/v1/projects", {
    headers: { "cf-access-jwt-assertion": jwt },
  });
  const verify = (token, iss, aud) =>
    verifyAccessToken(token, iss, aud, resolver);
  await assert.rejects(
    authenticate(db, accessRequest, accessSettings, verify),
    /provisioned/,
  );
  sqlite
    .prepare(
      "INSERT INTO auth_identity_links(issuer,subject,user_id) VALUES(?,?,?)",
    )
    .run(issuer, "external-subject", "alice");
  assert.equal(
    (await authenticate(db, accessRequest, accessSettings, verify)).userId,
    "alice",
  );
  sqlite
    .prepare(
      "INSERT INTO auth_access_revocations(token_hash,expires_at) VALUES(?,?)",
    )
    .run(await digest(jwt), Date.now() + 60000);
  await assert.rejects(
    authenticate(db, accessRequest, accessSettings, verify),
    /revoked/,
  );
  sqlite.prepare("UPDATE auth_access_revocations SET expires_at=0").run();
  assert.equal(
    (await authenticate(db, accessRequest, accessSettings, verify)).userId,
    "alice",
  );
  console.log(
    "PASS explicit production identity linking, signed-token authentication and server-side logout revocation",
  );
  assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  console.log(
    "PASS deterministic disjoint partitions, shared voting sets, frozen plans, job isolation, retries, profile changes and completion-gated final results",
  );
  console.log(
    "PASS authenticated owner/admin/project scope, actor spoof rejection, fail-closed configuration and signed JWT issuer/audience/expiry verification",
  );
  console.log("Disposable SQLite:", filename);
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sqlite.close());
