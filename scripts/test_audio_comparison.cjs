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
const { taskInstanceService: tasks } = load(
  "lib/backend/services/task-instances.ts",
);
const { assignmentService: assignments } = load(
  "lib/backend/services/assignments.ts",
);
const { annotationService: annotations, AnnotationAnswerError } = load(
  "lib/backend/services/annotations.ts",
);
const { taskDraftSchema } = load("lib/backend/validation/task-definitions.ts");
const { validateAnswers } = load(
  "lib/backend/validation/annotation-answers.ts",
);
const model = load("components/task-builder/model.ts");
const React = require("react"),
  { renderToStaticMarkup } = require("react-dom/server");
const Fields = load("components/workbench/BlockFields.tsx").default;
const project = crypto.randomUUID(),
  dataset = crypto.randomUUID(),
  assets = Array.from({ length: 4 }, () => crypto.randomUUID());
const common = {
  name: "Audio comparison publication",
  description: "",
  domain: "sound",
  instructions: "Compare each ordered pair.",
  policy: {
    requiredIndependentVotes: 1,
    blindToOthers: true,
    requiresReview: false,
  },
};
const comparison = {
  ...model.newBlock("audio_comparison"),
  id: "compare",
  numBatch: 4,
  comparisonSize: 2,
  options: [
    { id: "left", label: "First recording" },
    { id: "right", label: "Second recording" },
  ],
};
(async () => {
  sqlite
    .prepare("INSERT INTO projects(id,name,slug) VALUES(?,?,?)")
    .run(project, "Comparison", project);
  sqlite
    .prepare("INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)")
    .run(dataset, project, "Recordings", "1");
  for (const id of assets)
    sqlite
      .prepare(
        "INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key,duration_seconds) VALUES(?,?,?,'r2',?,5)",
      )
      .run(id, dataset, id + ".wav", id + ".wav");
  for (const userId of ["alice", "bob"])
    await assignments.addMember(db, {
      projectId: project,
      userId,
      displayName: userId,
      role: "labeller",
    });
  assert.equal(model.canSubmit("audio_comparison"), true);
  assert.equal(model.publishLimit(comparison), undefined);
  const draft = {
    ...common,
    blocks: [
      comparison,
      { id: "note", type: "text", label: "Optional note", required: false },
    ],
  };
  assert.deepEqual(model.checkDraft(draft), []);
  const saved = await definitions.create(
    db,
    project,
    taskDraftSchema.parse(draft),
  );
  await definitions.publish(db, saved.id, 1, 0);
  assert.equal((await definitions.get(db, saved.id)).publishedVersion, 1);
  const t = await tasks.create(db, {
    projectId: project,
    definitionId: saved.id,
    definitionVersion: 1,
    assetId: assets[0],
    audioAssetIds: assets,
  });
  assert.deepEqual(
    t.audioAssets.map((asset) => asset.id),
    assets,
  );
  await assert.rejects(
    tasks.create(db, {
      projectId: project,
      definitionId: saved.id,
      definitionVersion: 1,
      assetId: assets[0],
      audioAssetIds: assets.slice(0, 2),
    }),
    /requires 4 recordings/,
  );
  const assignment = await assignments.create(db, {
    projectId: project,
    taskInstanceId: t.id,
    labellerId: "alice",
  });
  await assignments.create(db, {
    projectId: project,
    taskInstanceId: t.id,
    labellerId: "bob",
  });
  await annotations.save(
    db,
    assignment.id,
    { labellerId: "alice", expectedRevision: 0, answers: {} },
    "draft",
  );
  await annotations.save(
    db,
    assignment.id,
    {
      labellerId: "alice",
      expectedRevision: 1,
      answers: { compare: ["right", null] },
    },
    "draft",
  );
  assert.deepEqual(
    (await annotations.current(db, assignment.id, "alice")).current.answers,
    { compare: ["right", null] },
  );
  for (const answer of [
    null,
    "left",
    ["bogus", "left"],
    ["left"],
    ["left", null],
    ["left", "right", "left"],
    [1, "left"],
    [{ selection: "left" }, "right"],
  ]) {
    await assert.rejects(
      annotations.save(
        db,
        assignment.id,
        {
          labellerId: "alice",
          expectedRevision: 2,
          answers: { compare: answer },
        },
        "submitted",
      ),
      (error) => error instanceof AnnotationAnswerError,
    );
  }
  await assert.rejects(
    annotations.save(
      db,
      assignment.id,
      {
        labellerId: "alice",
        expectedRevision: 2,
        answers: { compare: ["unknown"] },
      },
      "draft",
    ),
    (error) => error instanceof AnnotationAnswerError,
  );
  assert.equal(
    (await annotations.current(db, assignment.id, "alice")).current.revision,
    2,
  );
  await assert.rejects(
    annotations.current(db, assignment.id, "bob"),
    /another labeller/,
  );
  // Edits after publishing cannot change allowed IDs in an active assignment.
  await definitions.update(
    db,
    saved.id,
    1,
    taskDraftSchema.parse({
      ...draft,
      blocks: [
        {
          ...comparison,
          options: [
            { id: "new-a", label: "New A" },
            { id: "new-b", label: "New B" },
          ],
        },
      ],
    }),
  );
  const answers = { compare: ["right", "left"], note: "Ordered pair results" };
  await annotations.save(
    db,
    assignment.id,
    { labellerId: "alice", expectedRevision: 2, answers },
    "submitted",
  );
  const reopened = await tasks.get(db, t.id),
    current = (await annotations.current(db, assignment.id, "alice")).current;
  assert.deepEqual(current.answers, answers);
  assert.equal(current.status, "submitted");
  assert.equal(current.revision, 3);
  assert.deepEqual(
    reopened.audioAssets.map((asset) => asset.id),
    assets,
  );
  assert.equal(reopened.definitionVersion, 1);
  assert.equal(
    (await assignments.list(db, project, "alice"))[0].status,
    "submitted",
  );
  const history = await annotations.history(db, assignment.id, "alice");
  assert.equal(history.length, 3);
  const html = renderToStaticMarkup(
    React.createElement(Fields, {
      blocks: reopened.definition.blocks,
      answers: current.answers,
      onChange() {},
      samples: {
        batchAudio: reopened.audioAssets.map((a) => ({
          id: a.id,
          url: "/api/v1/assets/" + a.id + "/audio",
          label: a.id,
        })),
      },
    }),
  );
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 2);
  for (const asset of assets) assert(html.includes(asset));
  assert.equal(
    taskDraftSchema.safeParse({
      ...common,
      blocks: [{ ...comparison, numBatch: 3 }],
    }).success,
    false,
  );
  assert.equal(
    taskDraftSchema.safeParse({
      ...common,
      blocks: [
        {
          ...comparison,
          options: [
            { id: "left", label: "A" },
            { id: "left", label: "B" },
          ],
        },
      ],
    }).success,
    false,
  );
  const defaultBlock = { ...comparison };
  delete defaultBlock.numBatch;
  assert(
    taskDraftSchema.safeParse({ ...common, blocks: [defaultBlock] }).success,
  );
  assert.deepEqual(model.checkDraft({ ...common, blocks: [defaultBlock] }), []);
  assert.deepEqual(
    validateAnswers(
      { ...common, blocks: [{ ...comparison, required: false }] },
      {},
      true,
      { audioAssetCount: 4 },
    ),
    [],
  );
  assert(
    validateAnswers(
      { ...common, blocks: [comparison] },
      { compare: ["left", "right"] },
      true,
      { audioAssetCount: 2 },
    ).length,
  );
  assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  sqlite.close();
  console.log(
    "PASS Audio Comparison: Builder/server publication, ordered 4-audio assignment, untouched/partial drafts, negative answers and audio-count checks, frozen IDs/version, final/reopen/order, revision history, worker isolation, selected answer SSR and status. Disposable SQLite: " +
      filename,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
