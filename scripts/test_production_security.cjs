/** R03 built Worker acceptance: real Vinext routing/proxy, D1, R2 and RS256.
 * Only the configured issuer's outbound JWKS is replaced by an isolated test
 * authority. No verifier injection, app test-auth flag, DEV compile substitution,
 * remote resources or preserved local state. TLS client tests trust a temporary
 * test CA and still verify hostname/certificate; they never use verify=false.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { createRequire } = require("node:module");
const { spawnSync, spawn } = require("node:child_process");
const https = require("node:https");
const pluginRequire = createRequire(
  path.join(
    fs.realpathSync(
      path.resolve(__dirname, "../node_modules/@cloudflare/vite-plugin"),
    ),
    "package.json",
  ),
);
const {
  Miniflare,
  convertV4MiniflareOptions,
  Response: MFResponse,
} = pluginRequire("miniflare");
const jose = require("jose");
const repo = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "audiolab-production-"));
fs.chmodSync(root, 0o700);
const output = path.join(repo, ".cloudflare/output/v0/workers/default");
const built = JSON.parse(
  fs.readFileSync(path.join(output, "worker.config.json")),
);
const issuer = "https://audiolab-test.cloudflareaccess.com",
  audience = "isolated-production-application";
let mf, server;
const observations = [];
function record(check) {
  observations.push(check);
  console.log("PASS " + check);
}
function python(code, args = []) {
  const result = spawnSync(
    process.env.AUDIOLAB_TEST_PYTHON || "python3",
    ["-B", "-c", code, ...args],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function runProcess(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => (stdout += value));
    child.stderr.on("data", (value) => (stderr += value));
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}
(async () => {
  // The bundle is compiled by vite build, whose import.meta.env.DEV is false.
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = {
    ...(await jose.exportJWK(publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  let jwksCalls = 0;
  const overrides = {};
  const settings = {
    AUTH_MODE: "access",
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUDIENCE: audience,
    APP_ORIGIN: "https://audio.example",
  };
  const bundle = path.join(output, "bundle");
  const modules = fs
    .readdirSync(bundle, { recursive: true })
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({ type: "ESModule", path: path.join(bundle, file) }));
  modules.sort(
    (a, b) =>
      Number(b.path === path.join(bundle, built.manifest.mainModule)) -
      Number(a.path === path.join(bundle, built.manifest.mainModule)),
  );
  const mfOptions = () =>
    convertV4MiniflareOptions({
      name: built.name,
      modules,
      modulesRoot: path.join(output, "bundle"),
      compatibilityDate: built.compatibilityDate,
      compatibilityFlags: built.compatibilityFlags,
      bindings: { ...settings, ...overrides },
      d1Databases: { DB: "r03-disposable" },
      r2Buckets: { AUDIO_BUCKET: "r03-private" },
      images: { binding: "IMAGES" },
      d1Persist: path.join(root, "d1"),
      r2Persist: path.join(root, "r2"),
      cf: false,
      assets: {
        directory: path.join(output, "assets"),
        binding: "ASSETS",
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
      },
      outboundService(request) {
        assert.equal(
          request.url,
          issuer + "/cdn-cgi/access/certs",
          "Unexpected outbound network attempt",
        );
        jwksCalls++;
        return new MFResponse(JSON.stringify({ keys: [jwk] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
  mf = new Miniflare(mfOptions());
  let db = await mf.getD1Database("DB");
  // sqlite.complete_statement splits actual migrations without breaking triggers.
  const migrations = python(
    `import sqlite3,json,re\nfrom pathlib import Path\nout=[]\nfor p in sorted(Path('migrations').glob('*.sql')):\n s=''; statements=[]\n clean=re.sub(r'--[^\\n]*', '', p.read_text())\n for line in clean.splitlines(True):\n  s+=line\n  if sqlite3.complete_statement(s): statements.append(s); s=''\n assert not ''.join(line for line in s.splitlines() if not line.strip().startswith('--')).strip(),p\n out.append([p.name,statements])\nprint(json.dumps(out))`,
  );
  for (const [name, statements] of JSON.parse(migrations)) {
    try {
      await db.batch(statements.map((sql) => db.prepare(sql)));
    } catch (error) {
      console.error("Migration fixture failed:", name);
      throw error;
    }
  }
  record("all current migrations on empty disposable real D1");
  async function token(subject, claims = {}, key = privateKey) {
    const now = Math.floor(Date.now() / 1000);
    return new jose.SignJWT({
      type: "app",
      sub: subject,
      iss: issuer,
      aud: [audience],
      iat: now,
      nbf: now,
      exp: now + 3600,
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .sign(key);
  }
  const admin = crypto.randomUUID(),
    alice = crypto.randomUUID(),
    bob = crypto.randomUUID(),
    outsider = crypto.randomUUID();
  const project = crypto.randomUUID();
  const manifest = {
    issuer,
    bootstrap: true,
    project: { id: project, name: "R03 Synthetic", slug: "r03-synthetic" },
    accounts: [
      {
        mode: "create",
        userId: admin,
        username: "r03-admin",
        displayName: "Researcher",
        subject: "subject-admin",
      },
    ],
    memberships: [{ projectId: project, userId: admin, role: "admin" }],
  };
  function plan(value) {
    const file = path.join(root, crypto.randomUUID() + ".json"),
      batchFile = file + ".batch";
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    const result = spawnSync(
      process.env.AUDIOLAB_TEST_PYTHON || "python3",
      [
        "-B",
        "scripts/provision_access.py",
        "--manifest",
        file,
        "--output",
        batchFile,
      ],
      { cwd: repo, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(batchFile).mode & 0o777, 0o600);
    return JSON.parse(fs.readFileSync(batchFile));
  }
  async function provision(value) {
    return db.batch(
      plan(value).map((q) => db.prepare(q.sql).bind(...q.params)),
    );
  }
  await provision(manifest);
  await provision(manifest);
  await provision({
    issuer,
    accounts: [
      {
        mode: "create",
        userId: alice,
        username: "r03-alice",
        displayName: "Alice",
        subject: "subject-alice",
      },
      {
        mode: "create",
        userId: bob,
        username: "r03-bob",
        displayName: "Bob",
        subject: "subject-bob",
      },
      {
        mode: "create",
        userId: outsider,
        username: "r03-other",
        displayName: "Other researcher",
        subject: "subject-other",
      },
    ],
    memberships: [
      { projectId: project, userId: alice, role: "labeller" },
      { projectId: project, userId: bob, role: "labeller" },
    ],
  });
  const before = await db
    .prepare("SELECT count(*) AS n FROM auth_accounts")
    .first();
  await assert.rejects(
    provision({
      ...manifest,
      accounts: [{ ...manifest.accounts[0], userId: crypto.randomUUID() }],
    }),
  );
  const rollbackUser = crypto.randomUUID();
  await assert.rejects(
    provision({
      issuer,
      accounts: [
        {
          mode: "create",
          userId: rollbackUser,
          username: "rollback-user",
          displayName: "Rollback",
          subject: "rollback-subject",
        },
      ],
      memberships: [
        {
          projectId: crypto.randomUUID(),
          userId: rollbackUser,
          role: "labeller",
        },
      ],
    }),
  );
  assert.deepEqual(
    await db.prepare("SELECT count(*) AS n FROM auth_accounts").first(),
    before,
  );
  record(
    "operator bootstrap/replay and conflicting identity batch rollback; no passwords",
  );
  let adminToken = await token("subject-admin"),
    aliceToken = await token("subject-alice"),
    bobToken = await token("subject-bob");
  async function raw(
    jwt,
    method,
    pathname,
    body,
    headers = {},
    origin = settings.APP_ORIGIN,
  ) {
    const h = new Headers(headers);
    if (jwt) h.set("cookie", "CF_Authorization=" + jwt);
    if (!["GET", "HEAD"].includes(method) && !h.has("origin"))
      h.set("origin", origin);
    let data = body;
    if (
      body !== undefined &&
      !(body instanceof FormData) &&
      typeof body !== "string"
    ) {
      data = JSON.stringify(body);
      h.set("content-type", "application/json");
    }
    const wire = new Request(origin + "/api/v1/" + pathname, {
      method,
      headers: h,
      body: data,
    });
    return mf.dispatchFetch(wire.url, {
      method,
      headers: wire.headers,
      body: ["GET", "HEAD"].includes(method)
        ? undefined
        : Buffer.from(await wire.arrayBuffer()),
    });
  }
  async function call(
    jwt,
    method,
    pathname,
    body,
    status = 200,
    headers = {},
    origin = settings.APP_ORIGIN,
  ) {
    const response = await raw(jwt, method, pathname, body, headers, origin);
    const text = await response.text();
    assert.equal(
      response.status,
      status,
      `${method} ${pathname}: ${response.status} ${text.slice(0, 300)}`,
    );
    assert(response.headers.get("cache-control")?.includes("no-store"));
    assert(!text.includes(adminToken), "Token leaked into a response");
    return text ? JSON.parse(text) : null;
  }
  await call(null, "GET", "projects", undefined, 401);
  const discovery = await call(adminToken, "GET", "auth/session");
  assert(discovery.configured && discovery.user.userId === admin);
  assert(discovery.loginUrl.startsWith(issuer + "/cdn-cgi/access/login/"));
  const expiredDiscovery = await call(
    await token("subject-admin", { exp: 1, iat: 0, nbf: 0 }),
    "GET",
    "auth/session",
  );
  assert.equal(expiredDiscovery.user, null);
  assert.equal(expiredDiscovery.status, 401);
  assert.equal(expiredDiscovery.loginUrl, discovery.loginUrl);
  for (const bad of [
    await token(
      "subject-admin",
      {},
      (await jose.generateKeyPair("RS256")).privateKey,
    ),
    await token("subject-admin", { iss: "https://wrong.cloudflareaccess.com" }),
    await token("subject-admin", { aud: ["wrong"] }),
    await token("subject-admin", { exp: 1, iat: 0, nbf: 0 }),
    await token("subject-admin", { nbf: Math.floor(Date.now() / 1000) + 600 }),
    await token("subject-admin", { iat: Math.floor(Date.now() / 1000) + 600 }),
    await token("subject-admin", { type: "org" }),
    await token("", { common_name: "synthetic.access" }),
    await token("unlinked"),
  ])
    await call(bad, "GET", "projects", undefined, 401);
  await db
    .prepare("UPDATE auth_accounts SET active=0 WHERE user_id=?")
    .bind(bob)
    .run();
  await call(bobToken, "GET", "projects", undefined, 403);
  await db
    .prepare("UPDATE auth_accounts SET active=1 WHERE user_id=?")
    .bind(bob)
    .run();
  await call(
    adminToken,
    "POST",
    "auth/login",
    { username: "r03-admin", password: "not-a-production-password" },
    403,
  );
  await call(
    adminToken,
    "POST",
    "datasets",
    { projectId: project, name: "CSRF", version: "v1" },
    403,
    { origin: "https://attacker.example" },
  );
  await call(
    adminToken,
    "POST",
    "datasets",
    { projectId: project, name: "CSRF", version: "v1" },
    403,
    { "sec-fetch-site": "cross-site" },
  );
  await call(
    adminToken,
    "GET",
    "projects",
    undefined,
    503,
    {},
    "https://alternate.example",
  );
  await call(adminToken, "GET", "unknown?projectId=" + project, undefined, 403);
  record(
    "actual middleware: missing/forged/wrong issuer/audience/expired/future/type/service/unlinked/inactive, DEV login, CSRF, alternate hostname, unknown route denial",
  );
  const created = await call(
    adminToken,
    "POST",
    "projects",
    { name: "New research", slug: "new-research" },
    201,
  );
  const otherProject = created.project.id;
  // Give the outsider only the second project's role, through the controlled model.
  await provision({
    issuer,
    accounts: [
      {
        mode: "link",
        userId: outsider,
        username: "r03-other",
        displayName: "Other researcher",
        subject: "subject-other",
      },
    ],
    memberships: [{ projectId: otherProject, userId: outsider, role: "admin" }],
  });
  const otherToken = await token("subject-other");
  assert.equal((await call(otherToken, "GET", "projects")).projects.length, 1);
  const dataset = (
    await call(
      adminToken,
      "POST",
      "datasets",
      { projectId: project, name: "Tones", version: "v1" },
      201,
    )
  ).dataset.id;
  await call(
    aliceToken,
    "POST",
    "datasets",
    { projectId: project, name: "Forbidden", version: "v1" },
    403,
  );
  await call(
    aliceToken,
    "POST",
    "project-members",
    { projectId: project, userId: alice, displayName: "Alice", role: "admin" },
    403,
  );
  assert.equal(
    (
      await mf.dispatchFetch(settings.APP_ORIGIN + "/api/v1/datasets", {
        method: "POST",
        headers: {
          cookie: "CF_Authorization=" + adminToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project,
          name: "Missing origin",
          version: "v1",
        }),
      })
    ).status,
    403,
  );
  await call(
    adminToken,
    "POST",
    "datasets",
    { projectId: project, name: "x".repeat(513 * 1024), version: "v1" },
    413,
  );
  await call(
    otherToken,
    "GET",
    "datasets?projectId=" + project,
    undefined,
    403,
  );
  const form = new FormData();
  form.set("datasetId", dataset);
  form.set("originalPath", "steady-tone.wav");
  form.set(
    "audio",
    new File(
      [
        fs.readFileSync(
          path.join(repo, "examples/datasets/synthetic/audio/steady-tone.wav"),
        ),
      ],
      "tone.wav",
      { type: "audio/wav" },
    ),
  );
  const asset = (await call(adminToken, "POST", "assets", form, 201)).asset;
  for (const [method, endpoint, body] of [
    ["POST", `source-records?projectId=${project}`, {}],
    ["GET", `annotation-candidates?assetId=${asset.id}`, undefined],
    ["POST", `assets/${asset.id}/metadata`, {}],
    [
      "GET",
      `labeller/audio-queue?projectId=${project}&labellerId=${admin}`,
      undefined,
    ],
  ])
    await call(adminToken, method, endpoint, body, 403);
  await call(aliceToken, "GET", `assets/${asset.id}/audio`, undefined, 403);
  await call(otherToken, "GET", `assets/${asset.id}/audio`, undefined, 403);
  const template = JSON.parse(
    fs.readFileSync(
      path.join(repo, "examples/datasets/synthetic/manifest.json"),
    ),
  );
  const source = {
    ...template,
    dataset_id: dataset,
    records: [{ ...template.records[0], audio_id: asset.id }],
  };
  source.records[0].metadata.private = "R03_PRIVATE_SOURCE";
  source.records[0].items[0].fields.private_note = {
    type: "text",
    visibility: "admin",
    value: "R03_PRIVATE_REFERENCE",
  };
  const ingest = `dataset-ingestion/import?projectId=${project}&userId=${admin}`;
  const importedSource = await call(adminToken, "POST", ingest, source);
  const sourceRecord = importedSource.accepted[0].source_record_id;
  const inspected = await call(
    adminToken,
    "GET",
    `dataset-ingestion/inspect?projectId=${project}&userId=${admin}&datasetId=${dataset}&recordId=${encodeURIComponent(sourceRecord)}&audioId=${asset.id}`,
  );
  assert(inspected.labels.length);
  await call(
    aliceToken,
    "POST",
    `dataset-ingestion/import?projectId=${project}&userId=${alice}`,
    source,
    403,
  );
  await call(
    otherToken,
    "POST",
    `dataset-ingestion/import?projectId=${project}&userId=${outsider}`,
    source,
    403,
  );
  await call(
    adminToken,
    "POST",
    `dataset-ingestion/import?projectId=${project}&userId=${alice}`,
    source,
    403,
  );
  const foreignDataset = (
    await call(
      otherToken,
      "POST",
      "datasets",
      { projectId: otherProject, name: "Other dataset", version: "v1" },
      201,
    )
  ).dataset.id;
  await call(
    otherToken,
    "POST",
    `dataset-ingestion/import?projectId=${otherProject}&userId=${outsider}`,
    { ...source, dataset_id: foreignDataset },
    422,
  );
  await call(adminToken, "GET", `source-records?assetId=${asset.id}`);
  await call(
    aliceToken,
    "GET",
    `source-fields?projectId=${project}&datasetId=${dataset}&userId=${alice}&recordId=steady-tone&view=admin`,
    undefined,
    403,
  );
  record(
    "authorized project/dataset/audio/canonical import; admin-only sources and actor/cross-project rejection",
  );
  const draft = {
    name: "Production classification",
    description: "Synthetic only",
    domain: "sound",
    instructions: "Listen independently",
    policy: {
      requiredIndependentVotes: 2,
      blindToOthers: true,
      requiresReview: false,
    },
    blocks: [
      {
        id: "category",
        type: "single_choice",
        label: "Tone kind",
        required: true,
        sourceBindings: {
          label: { kind: "dataset", fieldId: "item.prompt", type: "string" },
          options: {
            kind: "dataset",
            fieldId: "item.category",
            type: "choices",
          },
        },
        options: [
          { id: "steady", label: "Steady" },
          { id: "pulsed", label: "Pulsed" },
        ],
      },
    ],
  };
  const definition = (
    await call(
      adminToken,
      "POST",
      "task-definitions",
      { projectId: project, draft },
      201,
    )
  ).taskDefinition;
  await call(
    adminToken,
    "PUT",
    `task-definitions/${definition.id}`,
    {
      expectedRevision: 1,
      draft: { ...draft, description: "Published independently" },
    },
    200,
  );
  await call(
    adminToken,
    "POST",
    `task-definitions/${definition.id}/publish`,
    { expectedRevision: 2, expectedPublishedVersion: 0 },
    201,
  );
  await call(
    adminToken,
    "POST",
    `task-definitions/${definition.id}/publish`,
    "x".repeat(513 * 1024),
    413,
    { "content-type": "text/plain" },
  );
  await call(adminToken, "GET", `task-definitions/${definition.id}/versions/1`);
  const workerCatalog = await call(
    aliceToken,
    "GET",
    `task-definitions?projectId=${project}`,
  );
  assert(workerCatalog.definitions.some((row) => row.id === definition.id));
  assert(!JSON.stringify(workerCatalog).includes("sourceBindings"));
  assert(
    !workerCatalog.definitions.some(
      (row) => Object.hasOwn(row, "blocks") || Object.hasOwn(row, "draft"),
    ),
  );
  await call(
    aliceToken,
    "GET",
    `task-definitions/${definition.id}`,
    undefined,
    403,
  );
  await call(
    otherToken,
    "GET",
    `task-definitions/${definition.id}`,
    undefined,
    403,
  );
  const task = (
    await call(
      adminToken,
      "POST",
      "task-instances",
      {
        projectId: project,
        definitionId: definition.id,
        definitionVersion: 1,
        assetId: asset.id,
        sourceRecordId: sourceRecord,
      },
      201,
    )
  ).taskInstance;
  await call(otherToken, "GET", `task-instances/${task.id}`, undefined, 403);
  await call(
    adminToken,
    "POST",
    "task-instances",
    {
      projectId: otherProject,
      definitionId: definition.id,
      definitionVersion: 1,
      assetId: asset.id,
    },
    403,
  );
  const standalone = (
    await call(
      adminToken,
      "POST",
      "assignments",
      { projectId: project, taskInstanceId: task.id, labellerId: alice },
      201,
    )
  ).assignment;
  assert(standalone);
  await call(
    aliceToken,
    "POST",
    "assignments",
    { projectId: project, taskInstanceId: task.id, labellerId: bob },
    403,
  );
  // A real job supplies results/export identity; assignment creation remains
  // tested separately with a second published version to avoid duplicate tasks.
  const items = (
    await call(
      adminToken,
      "GET",
      `team-jobs?action=items&projectId=${project}&datasetId=${dataset}`,
    )
  ).items;
  const job = {
    jobId: crypto.randomUUID(),
    projectId: project,
    name: "Independent production task",
    datasetId: dataset,
    definitionId: definition.id,
    definitionVersion: 1,
    mode: "voting",
    seed: "r03",
    sampleCount: 1,
    itemKeys: [items[0].key],
    workerIds: [alice, bob],
  };
  const preview = (
    await call(adminToken, "POST", "team-jobs?action=preview", job)
  ).plan;
  await call(
    adminToken,
    "POST",
    "team-jobs?action=preview",
    { ...job, definitionVersion: 999 },
    404,
  );
  // Fault-inject malformed persisted JSON shape only in the disposable store.
  // Application publish APIs remain immutable; restore exact snapshot bytes even
  // if the generic-error assertion fails, rather than retaining altered fixtures.
  const frozen = await db
    .prepare(
      "SELECT definition_json AS json FROM task_definition_versions WHERE definition_id=? AND version=1",
    )
    .bind(definition.id)
    .first();
  try {
    await db
      .prepare(
        "UPDATE task_definition_versions SET definition_json=? WHERE definition_id=? AND version=1",
      )
      .bind(JSON.stringify({ blocks: "R03_PRIVATE_CORRUPTION" }), definition.id)
      .run();
    const failed = await call(
      adminToken,
      "POST",
      "team-jobs?action=preview",
      job,
      500,
    );
    assert(!JSON.stringify(failed).includes("R03_PRIVATE_"));
    assert(!JSON.stringify(failed).includes("blocks.some"));
  } finally {
    await db
      .prepare(
        "UPDATE task_definition_versions SET definition_json=? WHERE definition_id=? AND version=1",
      )
      .bind(frozen.json, definition.id)
      .run();
  }
  const launched = await call(adminToken, "POST", "team-jobs?action=launch", {
    ...preview.input,
    expectedHash: preview.hash,
  });
  const resultsPath = `team-jobs?action=results&projectId=${project}&jobId=${job.jobId}`;
  assert.equal((await call(adminToken, "GET", resultsPath)).complete, false);
  await call(aliceToken, "GET", resultsPath, undefined, 403);
  await call(otherToken, "GET", resultsPath, undefined, 403);
  const exportPath = `research-export?projectId=${project}&jobId=${job.jobId}&format=json`;
  await call(aliceToken, "GET", exportPath, undefined, 403);
  await call(otherToken, "GET", exportPath, undefined, 403);
  for (const [index, [user, jwt]] of [
    [alice, aliceToken],
    [bob, bobToken],
  ].entries()) {
    const assignment = launched.assignments.find((a) => a.userId === user);
    const queue = await call(
      jwt,
      "GET",
      `labeller/assigned-queue?projectId=${project}&labellerId=${user}`,
    );
    assert(queue.groups.some((g) => g.assignmentId === assignment.id));
    for (const endpoint of ["queue", "queue/page", "overview"]) {
      const own = await call(
        jwt,
        "GET",
        `labeller/${endpoint}?projectId=${project}&labellerId=${user}`,
      );
      assert(!JSON.stringify(own).includes("R03_PRIVATE_"));
    }
    await call(
      jwt,
      "GET",
      `labeller/assigned-queue?projectId=${project}&labellerId=${admin}`,
      undefined,
      403,
    );
    const detail = await call(jwt, "GET", `assignments/${assignment.id}`);
    assert(!JSON.stringify(detail).includes("reference_answer"));
    assert(!JSON.stringify(detail).includes("R03_PRIVATE_"));
    assert(
      detail.taskInstance.resolvedDefinition.blocks[0].label.includes("tone"),
    );
    await call(
      index ? aliceToken : bobToken,
      "GET",
      `assignments/${assignment.id}`,
      undefined,
      403,
    );
    await call(
      otherToken,
      "GET",
      `assignments/${assignment.id}`,
      undefined,
      403,
    );
    await call(
      jwt,
      "POST",
      `assignments/${assignment.id}/annotation/submit`,
      {
        labellerId: admin,
        expectedRevision: 0,
        answers: { category: "steady" },
      },
      403,
    );
    await call(
      jwt,
      "POST",
      `assignments/${assignment.id}/annotation/draft`,
      { labellerId: user, expectedRevision: 0, answers: {} },
      201,
    );
    const answers = { category: index ? "pulsed" : "steady" };
    const now = Math.floor(Date.now() / 1000);
    const expiredDuringDraft = await token(jose.decodeJwt(jwt).sub, { iat: now - 120, exp: now - 60 });
    await call(expiredDuringDraft, "POST", `assignments/${assignment.id}/annotation/draft`,
      { labellerId: user, expectedRevision: 1, answers }, 401);
    const retainedDraft = await call(jwt, "GET", `assignments/${assignment.id}/annotation?labellerId=${user}`);
    assert.equal(retainedDraft.current.revision, 1);
    assert.deepEqual(retainedDraft.current.answers, {});
    await call(
      jwt,
      "POST",
      `assignments/${assignment.id}/annotation/submit`,
      { labellerId: user, expectedRevision: 1, answers },
      201,
    );
    assert.deepEqual(
      (
        await call(
          jwt,
          "GET",
          `assignments/${assignment.id}/annotation?labellerId=${user}`,
        )
      ).current.answers,
      answers,
    );
    const audio = await raw(jwt, "GET", `assets/${asset.id}/audio`, undefined, {
      range: "bytes=0-43",
    });
    assert.equal(audio.status, 206);
    assert.equal(
      Buffer.from(await audio.arrayBuffer())
        .subarray(0, 4)
        .toString(),
      "RIFF",
    );
  }
  const results = await call(adminToken, "GET", resultsPath),
    exported = await call(adminToken, "GET", exportPath);
  assert(results.complete);
  assert.equal(results.workerSubmissions, 2);
  assert.deepEqual(exported.analytics, results);
  assert.equal(exported.tasks[0].annotations.length, 2);
  record(
    "publish/pinned version, task scope, job preview/launch, independent drafts/submits/reload, expiry during draft preserves revision, assigned playback, results/export equality and peer isolation",
  );
  // Exercise the same compiled routing/auth boundary at the proposed canonical
  // workers.dev origin. Miniflare does not simulate Cloudflare's Access edge or
  // BIC: these assertions prove app-layer isolation, not live URL protection.
  const customOrigin = settings.APP_ORIGIN;
  settings.APP_ORIGIN = "https://audiolab-staging.isolated-account.workers.dev";
  try {
    await mf.setOptions(mfOptions());
    db = await mf.getD1Database("DB");
    assert.equal(
      (await call(adminToken, "GET", "auth/session")).user.userId,
      admin,
    );
    await call(adminToken, "GET", "projects");
    await call(null, "GET", "projects", undefined, 401);
    for (const bad of [
      await token(
        "subject-admin",
        {},
        (await jose.generateKeyPair("RS256")).privateKey,
      ),
      await token("subject-admin", {
        iss: "https://wrong.cloudflareaccess.com",
      }),
      await token("subject-admin", { aud: ["wrong"] }),
      await token("subject-admin", { exp: 1, iat: 0, nbf: 0 }),
      await token("unlinked"),
    ])
      await call(bad, "GET", "projects", undefined, 401);
    await call(
      adminToken,
      "POST",
      "auth/login",
      { username: "r03-admin", password: "not-real" },
      403,
    );
    const owned = launched.assignments.find((a) => a.userId === alice);
    const foreign = launched.assignments.find((a) => a.userId === bob);
    const own = await call(aliceToken, "GET", `assignments/${owned.id}`);
    assert(!JSON.stringify(own).includes("R03_PRIVATE_"));
    assert(!JSON.stringify(own).includes("reference_answer"));
    await call(aliceToken, "GET", `assignments/${foreign.id}`, undefined, 403);
    await call(aliceToken, "GET", exportPath, undefined, 403);
    await call(
      otherToken,
      "GET",
      `datasets?projectId=${project}`,
      undefined,
      403,
    );
    await call(otherToken, "GET", `assets/${asset.id}/audio`, undefined, 403);
    assert.equal(
      (await raw(aliceToken, "GET", `assets/${asset.id}/audio`)).status,
      200,
    );
    const canonicalResults = await call(adminToken, "GET", resultsPath);
    assert.deepEqual(
      (await call(adminToken, "GET", exportPath)).analytics,
      canonicalResults,
    );
    assert.deepEqual(canonicalResults, results);
    await call(
      adminToken,
      "POST",
      "datasets",
      { projectId: project, name: "CSRF", version: "v1" },
      403,
      { origin: customOrigin },
    );
    for (const alternate of [
      customOrigin,
      "https://other-worker.isolated-account.workers.dev",
      "https://audiolab-staging.other-account.workers.dev",
      "https://version-audiolab-staging.isolated-account.workers.dev",
      "https://preview-audiolab-staging.isolated-account.workers.dev",
      "https://deployment-audiolab-staging.isolated-account.workers.dev",
    ])
      await call(
        adminToken,
        "GET",
        "projects",
        undefined,
        503,
        {
          origin: settings.APP_ORIGIN,
          "x-forwarded-host": new URL(settings.APP_ORIGIN).hostname,
          "x-forwarded-proto": "https",
        },
        alternate,
      );
    await call(adminToken, "POST", "auth/logout", {});
    await call(adminToken, "GET", "projects", undefined, 401);
    adminToken = await token("subject-admin", { jti: crypto.randomUUID() });
    await call(adminToken, "GET", "projects");
    record(
      "isolated workers.dev built-Worker JWT/roles/private references/assigned audio/export equality/CSRF/revocation; alternate Worker/account/version/preview/deployment origins rejected despite forwarded headers; edge Access NOT simulated",
    );
  } finally {
    settings.APP_ORIGIN = customOrigin;
    await mf.setOptions(mfOptions());
    db = await mf.getD1Database("DB");
  }
  // R02B storage failure/recovery: remove only this harness's synthetic object,
  // retaining the real asset metadata, answers and immutable revisions in D1.
  const bucket = await mf.getR2Bucket("AUDIO_BUCKET");
  const storage = await db.prepare("SELECT storage_key AS key FROM audio_assets WHERE id=?").bind(asset.id).first();
  const object = await bucket.get(storage.key);
  assert(object);
  const originalBytes = await object.arrayBuffer();
  try {
    await bucket.delete(storage.key);
    await call(aliceToken, "GET", `assets/${asset.id}/audio`, undefined, 404);
    const withoutAudio = await call(adminToken, "GET", exportPath);
    assert.deepEqual(withoutAudio.analytics, results);
    assert.deepEqual(withoutAudio.tasks[0].annotations, exported.tasks[0].annotations);
    await call(adminToken, "GET", exportPath.replace("format=json", "format=audio-zip"), undefined, 404);
  } finally {
    await bucket.put(storage.key, originalBytes, { httpMetadata: object.httpMetadata, customMetadata: object.customMetadata });
  }
  assert.equal((await raw(aliceToken, "GET", `assets/${asset.id}/audio`)).status, 200);
  record("missing R2 object returns explicit failure; raw export/analytics/revisions survive and playback recovers after object restore");
  // Reconfigure only the harness bindings, never application logic; production
  // compiled DEV login remains closed even if an operator supplies demo mode.
  for (const bad of [
    { ACCESS_AUDIENCE: "" },
    { ACCESS_TEAM_DOMAIN: "https://evil.example" },
    { APP_ORIGIN: "" },
    { AUTH_MODE: "demo" },
    { AUTH_MODE: "typo" },
  ]) {
    Object.assign(overrides, bad);
    await mf.setOptions(mfOptions());
    await call(adminToken, "GET", "projects", undefined, 503);
    const discovery = await call(null, "GET", "auth/session");
    assert.equal(discovery.configured, false);
    await call(
      null,
      "POST",
      "auth/login",
      { username: "r03-admin", password: "not-real" },
      403,
    );
    for (const key of Object.keys(bad)) delete overrides[key];
  }
  await mf.setOptions(mfOptions());
  db = await mf.getD1Database("DB");
  await call(adminToken, "POST", "auth/logout", {});
  await call(adminToken, "GET", "projects", undefined, 401);
  adminToken = await token("subject-admin", { jti: crypto.randomUUID() });
  await call(adminToken, "GET", "projects");
  record(
    "missing/invalid production configuration fails closed; logout revokes exact bearer token",
  );
  const guest = crypto.randomUUID();
  await call(
    adminToken,
    "POST",
    "project-members",
    {
      projectId: project,
      userId: guest,
      displayName: "Guest",
      role: "labeller",
    },
    422,
  );
  await provision({
    issuer,
    accounts: [
      {
        mode: "create",
        userId: guest,
        username: "r03-guest",
        displayName: "Guest",
        subject: "subject-guest",
      },
    ],
    memberships: [],
  });
  await call(
    adminToken,
    "POST",
    "project-members",
    {
      projectId: project,
      userId: guest,
      displayName: "Guest",
      role: "labeller",
    },
    201,
  );
  await call(adminToken, "POST", "worker-profiles", {
    projectId: project,
    userId: alice,
    country: "",
    profession: "Research",
    languages: ["English"],
    experienceYears: 1,
    active: true,
    metadata: { fixture: "synthetic" },
  });
  await call(adminToken, "POST", "worker-profiles?action=team", {
    projectId: project,
    name: "Synthetic team",
    memberIds: [alice, bob],
  });
  await call(adminToken, "GET", `worker-profiles?projectId=${project}`);
  assert.equal(
    (await call(aliceToken, "GET", `project-members?projectId=${project}`))
      .members.length,
    1,
  );
  record(
    "production membership requires linked active accounts; admin worker/team writes and owner-only member listing",
  );
  // TLS bridge preserves the complete request URL/headers and calls the built
  // routing entrypoint. A temporary CA is trusted only by the test subprocess.
  const keyfile = path.join(root, "tls.key"),
    certfile = path.join(root, "tls.crt");
  const cert = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyfile,
      "-out",
      certfile,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cert.status, 0, "OpenSSL fixture certificate creation failed");
  fs.chmodSync(keyfile, 0o600);
  server = https.createServer(
    { key: fs.readFileSync(keyfile), cert: fs.readFileSync(certfile) },
    async (req, res) => {
      try {
        const body = [];
        for await (const chunk of req) body.push(chunk);
        const result = await mf.dispatchFetch(settings.APP_ORIGIN + req.url, {
          method: req.method,
          headers: req.headers,
          body: ["GET", "HEAD"].includes(req.method)
            ? undefined
            : Buffer.concat(body),
        });
        res.writeHead(result.status, Object.fromEntries(result.headers));
        res.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end("Test bridge failed");
      }
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  settings.APP_ORIGIN = `https://127.0.0.1:${server.address().port}`;
  await mf.setOptions(mfOptions());
  db = await mf.getD1Database("DB");
  const credential = path.join(root, "access.json");
  fs.writeFileSync(
    credential,
    JSON.stringify({ origin: settings.APP_ORIGIN, token: adminToken }),
    { mode: 0o600 },
  );
  const runner = path.join(root, "cli_runner.py");
  fs.writeFileSync(
    runner,
    `import runpy,sys,requests\noriginal=requests.Session\nca=sys.argv[1]\ndef session():\n s=original();s.verify=ca;return s\nrequests.Session=session\nsys.argv=sys.argv[2:]\nrunpy.run_path('scripts/import_dataset.py',run_name='__main__')\n`,
  );
  const cliArgs = [
    "--base-url",
    settings.APP_ORIGIN,
    "--auth",
    "access",
    "--access-token-file",
    credential,
    "--project-id",
    project,
    "--create-dataset",
    "HTTPS CLI example",
    "--adapter",
    "canonical",
    "--manifest",
    "examples/datasets/synthetic/manifest.json",
    "--root",
    "examples/datasets/synthetic/audio",
    "--output",
    path.join(root, "cli-import"),
    "--import",
  ];
  const interpreter = process.env.AUDIOLAB_TEST_PYTHON || "python3";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runProcess(interpreter, [
      "-B",
      runner,
      certfile,
      "scripts/import_dataset.py",
      ...cliArgs,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert(!result.stdout.includes(adminToken));
  }
  const report = JSON.parse(
    fs.readFileSync(path.join(root, "cli-import/report.json")),
  );
  assert.equal(report.status, "complete");
  assert.equal(report.acceptedItems.length, 2);
  assert.equal(report.reusedAudio.length, 2);
  fs.writeFileSync(
    credential,
    JSON.stringify({ origin: settings.APP_ORIGIN, token: aliceToken }),
    { mode: 0o600 },
  );
  const denied = await runProcess(interpreter, [
    "-B",
    runner,
    certfile,
    "scripts/import_dataset.py",
    ...cliArgs,
  ]);
  assert.notEqual(denied.status, 0);
  assert(!denied.stderr.includes(aliceToken));
  record(
    "real HTTPS Python CLI Access import/retry and worker denial with certificate validation",
  );
  const foreign = await db.prepare("PRAGMA foreign_key_check").all();
  assert.equal(foreign.results.length, 0);
  const counts = {};
  for (const table of [
    "projects",
    "auth_accounts",
    "auth_identity_links",
    "datasets",
    "audio_assets",
    "source_records",
    "assignments",
    "annotation_revisions",
  ])
    counts[table] = (
      await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()
    ).n;
  fs.writeFileSync(
    path.join(root, "acceptance.json"),
    JSON.stringify(
      {
        status: "PASS",
        observations,
        jwksCalls,
        counts,
        projectId: project,
        jobId: job.jobId,
        origin: settings.APP_ORIGIN,
      },
      null,
      2,
    ),
  );
  console.log("Evidence:", root);
})()
  .catch((error) => {
    console.error(error);
    console.error("Failed evidence:", root);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mf) await mf.dispose();
  });
