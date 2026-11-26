/** R02A persisted reproduction and version/repeated-group/export regression.
 * Real services/repositories on a new disposable on-disk SQLite DB, never
 * preserved D1/R2. Run: node scripts/test_final_results.cjs
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
    name: "Split intervals",
    description: "",
    domain: "sound",
    instructions: "Listen",
    policy: {
      requiredIndependentVotes: 2,
      blindToOthers: true,
      requiresReview: false,
    },
    blocks: [
      {
        id: "ground",
        type: "timeline_annotation",
        label: "Events",
        required: false,
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
  });
  const definition = await definitions.create(db, project, draft);
  await definitions.publish(db, definition.id, 1, 0);
  const plan = await buildJobPlan(db, actor, {
    jobId: crypto.randomUUID(),
    projectId: project,
    name: "Split reproduction",
    datasetId: dataset,
    definitionId: definition.id,
    definitionVersion: 1,
    mode: "voting",
    seed: "r02a",
    sampleCount: 1,
    itemKeys: (
      await db.prepare("SELECT id FROM source_records").all()
    ).results.map((x) => x.id),
    workerIds: ["alice", "bob"],
  });
  const launched = await launchJob(db, actor, plan.input, plan.hash);
  const values = [
    {
      tiers: {
        events: [
          { id: "a", start: 1, end: 3, text: "tone" },
          { id: "b", start: 3, end: 5, text: "tone" },
        ],
      },
    },
    { tiers: { events: [{ id: "c", start: 1, end: 5, text: "tone" }] } },
  ];
  for (const [index, a] of launched.assignments.entries())
    await annotations.save(
      db,
      a.id,
      {
        labellerId: a.userId,
        expectedRevision: 0,
        answers: { ground: values[index] },
      },
      "submitted",
    );
  sqlite.close();
  sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA foreign_keys=ON");
  const result = await jobResults(db, actor, plan.input.jobId);
  console.log("Persisted split-interval IoU:", result.blocks[0].meanSimilarity);
  assert.equal(result.blocks[0].meanSimilarity, 1);

  // Publish another immutable version: old jobs must keep their resolved form.
  const v2 = {
    ...draft,
    name: "Typed analytics",
    blocks: [
      { id: "quantity", type: "number", label: "Count", required: true },
      { id: "text", type: "text", label: "Response", required: true },
      {
        id: "group",
        type: "repeated_group",
        label: "Independent manual entries",
        required: true,
        minEntries: 1,
        maxEntries: 5,
        blocks: [
          {
            id: "child",
            type: "text",
            label: "Child response",
            required: true,
          },
        ],
      },
    ],
  };
  await definitions.update(db, definition.id, 1, v2);
  await definitions.publish(db, definition.id, 2, 1);
  const next = await buildJobPlan(db, actor, {
    ...plan.input,
    jobId: crypto.randomUUID(),
    definitionVersion: 2,
    workerIds: ["alice", "bob", "chai"],
  });
  const jobs = await launchJob(db, actor, next.input, next.hash);
  for (const [index, a] of jobs.assignments.entries())
    await annotations.save(
      db,
      a.id,
      {
        labellerId: a.userId,
        expectedRevision: 0,
        answers: {
          quantity: index + 1,
          text: "Readable response " + index,
          group: [
            {
              id: "same-worker-local-id",
              answers: { child: "Different event " + index },
            },
          ],
        },
      },
      "submitted",
    );
  const second = await jobResults(db, actor, next.input.jobId);
  assert.equal(
    second.items.find((i) => i.block.id === "quantity").numeric.mean,
    2,
  );
  const children = second.items.filter((i) => i.block.id === "child");
  assert.equal(children.length, 3);
  assert(
    children.every((i) => i.eligiblePairs === 0 && i.validObservations === 1),
    "Manual IDs/order must not align unrelated workers",
  );
  assert.equal(
    (await jobResults(db, actor, plan.input.jobId)).items[0].definitionVersion,
    1,
  );
  assert(second.items.every((i) => i.definitionVersion === 2));
  const exported = await load(
    "lib/backend/services/research-export.ts",
  ).buildResearchExport(db, actor, project, plan.input.jobId);
  assert.deepEqual(exported.analytics, result);
  // Export order is not allocation order; compare by durable assignment identity.
  for (const annotation of exported.tasks[0].annotations) {
    const index = launched.assignments.findIndex(
      (a) => a.id === annotation.assignmentId,
    );
    assert(index >= 0);
    assert.deepEqual(annotation.answers.ground, values[index]);
  }
  // Four genuinely distinct recordings/questions: no pooled ordinal IDs may
  // substitute for per-question reference matching or rank-position counts.
  const assets = Array.from({ length: 4 }, () => crypto.randomUUID());
  for (const [i, id] of assets.entries())
    sqlite
      .prepare(
        "INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key) VALUES(?,?,?,'r2',?)",
      )
      .run(id, dataset, `question-${i}.wav`, `question-${i}.wav`);
  const importedBatch = await ingestDataset(
    db,
    project,
    actor,
    {
      schema_version: 1,
      dataset_id: dataset,
      source_version: "batch-v1",
      provenance: { origin: "synthetic", revision: "1" },
      records: assets.map((id, i) => ({
        sample_id: `batch-${i}`,
        audio_id: id,
        fields: {},
        items: [
          {
            item_id: "question",
            fields: {
              question: field(`Question ${i}`),
              options: {
                type: "choices",
                visibility: "worker",
                value: [
                  { id: "a", label: `Answer ${i} A` },
                  { id: "b", label: `Answer ${i} B` },
                ],
              },
            },
          },
        ],
      })),
    },
    true,
  );
  assert(importedBatch.ok);
  const records = sqlite
    .prepare(
      `SELECT id,asset_id FROM source_records WHERE asset_id IN (${assets.map(() => "?").join(",")})`,
    )
    .all(...assets);
  for (const r of records) {
    const i = assets.indexOf(r.asset_id);
    sqlite
      .prepare(
        "INSERT INTO source_labels(id,source_record_id,kind,payload_json,provenance) VALUES(?,?,'reference_answer',?,'synthetic')",
      )
      .run(
        crypto.randomUUID(),
        r.id,
        JSON.stringify({
          value: `Answer ${i} A`,
          privateNote: "must never leave admin storage",
        }),
      );
  }
  const boundChoice = {
    id: "question",
    type: "single_choice",
    label: "Question",
    required: true,
    numBatch: 4,
    sourceBindings: {
      label: { kind: "dataset", fieldId: "item.question", type: "string" },
      options: {
        kind: "dataset",
        fieldId: "item.options",
        type: "choices",
        format: "array",
      },
    },
  };
  const batchDraft = taskDraftSchema.parse({
    ...draft,
    name: "Four question acceptance",
    blocks: [
      boundChoice,
      {
        ...draft.blocks[0],
        groundingMode: "flexible",
        tiers: [
          {
            id: "words",
            name: "Words",
            kind: "interval",
            labelMode: "text",
            allowOverlap: true,
          },
          {
            id: "phones",
            name: "Phones",
            kind: "interval",
            labelMode: "ipa",
            allowOverlap: true,
          },
          {
            id: "events",
            name: "Sounds",
            kind: "interval",
            labelMode: "text",
            allowOverlap: true,
          },
        ],
      },
      {
        id: "rank",
        type: "ranking",
        label: "Rank recordings",
        required: true,
        rankingMode: "audios",
        stimulusSlots: ["A", "B", "C", "D"],
      },
    ],
  });
  const bd = await definitions.create(db, project, batchDraft);
  await definitions.publish(db, bd.id, 1, 0);
  const bp = await buildJobPlan(db, actor, {
    ...plan.input,
    jobId: crypto.randomUUID(),
    name: "Four question acceptance",
    definitionId: bd.id,
    definitionVersion: 1,
    workerIds: workers,
    itemKeys: records.map((r) => r.id),
    sampleCount: 4,
  });
  const bl = await launchJob(db, actor, bp.input, bp.hash);
  assert.equal(bl.assignments.length, 3);
  for (const [i, a] of bl.assignments.entries())
    await annotations.save(
      db,
      a.id,
      {
        labellerId: a.userId,
        expectedRevision: 0,
        answers: {
          question: Array(4).fill(i === 2 ? "b" : "a"),
          rank:
            i === 2
              ? ["slot-3", "slot-2", "slot-1", "slot-0"]
              : ["slot-0", "slot-1", "slot-2", "slot-3"],
        },
      },
      "submitted",
    );
  const br = await jobResults(db, actor, bp.input.jobId);
  const questions = br.items.filter((i) => i.block.type === "single_choice");
  assert.equal(questions.length, 4);
  assert.equal(new Set(questions.map((i) => i.block.label)).size, 4);
  for (const q of questions) {
    assert.equal(q.sourceKeys.length, 1);
    assert.equal(q.audio.length, 1);
    assert.deepEqual(
      q.distribution.counts.map((c) => c.count),
      [2, 1],
    );
    assert.deepEqual(q.reference.observations.map((o) => o.match).sort(), [
      false,
      true,
      true,
    ]);
  }
  assert(!JSON.stringify(br).includes("privateNote"));
  const ranked = br.items.find((i) => i.block.type === "ranking");
  assert.deepEqual(ranked.distribution.ranks[0].positions, [2, 0, 0, 1]);
  assert.equal(ranked.eligiblePairs, 3);
  assert.equal(ranked.mean, 1 / 3);
  assert(
    br.items
      .filter((i) => i.block.type === "timeline_annotation")
      .every((i) => i.validObservations === 0 && i.eligiblePairs === 0),
  );
  await assert.rejects(
    jobResults(db, "alice", bp.input.jobId),
    /admin|forbidden/i,
  );
  const batchExport = await load(
    "lib/backend/services/research-export.ts",
  ).buildResearchExport(db, actor, project, bp.input.jobId);
  assert.deepEqual(batchExport.analytics, br);
  assert.equal(batchExport.totals.exportedSubmissions, 3);
  const trainingDraft = taskDraftSchema.parse({
    ...batchDraft,
    name: "Explicit training",
    blocks: [
      {
        ...boundChoice,
        trainingAnswerPreview: true,
        showSourceAnswer: true,
        sourceBindings: {
          ...boundChoice.sourceBindings,
          preview: {
            kind: "dataset",
            fieldId: "reference_answer",
            type: "json",
          },
        },
      },
    ],
  });
  const td = await definitions.create(db, project, trainingDraft);
  await definitions.publish(db, td.id, 1, 0);
  const tp = await buildJobPlan(db, actor, {
    ...bp.input,
    jobId: crypto.randomUUID(),
    definitionId: td.id,
  });
  const tl = await launchJob(db, actor, tp.input, tp.hash);
  const taskInstances = load(
    "lib/backend/services/task-instances.ts",
  ).taskInstanceService;
  const trainingTask = await taskInstances.get(
    db,
    sqlite
      .prepare("SELECT task_instance_id AS id FROM assignments WHERE id=?")
      .get(tl.assignments[0].id).id,
  );
  assert.equal(trainingTask.resolvedDefinition.blocks[0].batchBlocks.length, 4);
  for (const panel of trainingTask.resolvedDefinition.blocks[0].batchBlocks)
    assert.equal(panel.sourceAnswerPreview, panel.options[0].label);
  assert(!JSON.stringify(trainingTask).includes("privateNote"));
  const blindTask = await taskInstances.get(
    db,
    sqlite
      .prepare("SELECT task_instance_id AS id FROM assignments WHERE id=?")
      .get(bl.assignments[0].id).id,
  );
  assert(
    blindTask.resolvedDefinition.blocks[0].batchBlocks.every(
      (b) => b.sourceAnswerPreview === undefined,
    ),
  );
  console.log(
    "PASS persisted batch4 optional aid, per-question distributions/references, ranking histograms/agreement, exact export parity and admin isolation; explicit training preview without private metadata",
  );
  console.log(
    "PASS published v1/v2 isolation, numeric/text/manual-group child identities, persisted immutable answers and shared export metrics",
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sqlite.close());
