/** Ingestion + binding + architecture corrections: real services/handlers and SQL on a disposable on-disk SQLite DB.
 * No browser, build, precious state or remote D1. Run: node scripts/test_preannotated_blocks.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const ts = require("@typescript/typescript6");
const root = path.resolve(__dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiolab-c05-"));
const filename = path.join(directory, "candidate-votes.sqlite");
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
      if (name === "cloudflare:workers") return { env: { DB: db } };
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
const {
  annotationService: annotations,
  AnnotationAnswerError,
  AnnotationConflictError,
} = load("lib/backend/services/annotations.ts");
const { candidateSetService: sets, CandidateSetError } = load(
  "lib/backend/services/candidate-sets.ts",
);
const { candidateSetRepository: repo } = load(
  "lib/backend/repositories/candidate-sets.ts",
);
const { taskDraftSchema } = load("lib/backend/validation/task-definitions.ts");
const { createCandidateSetSchema } = load(
  "lib/backend/validation/candidate-sets.ts",
);
const project = crypto.randomUUID(),
  dataset = crypto.randomUUID(),
  asset = crypto.randomUUID(),
  asset2 = crypto.randomUUID();
const foreignProject = crypto.randomUUID(),
  foreignDataset = crypto.randomUUID(),
  foreignAsset = crypto.randomUUID();
const record = asset + "::question",
  secondRecord = asset + "::second",
  otherRecord = asset2 + "::question";
const earlyId = record + "::early_annotation",
  referenceId = record + "::reference_answer";
const common = {
  name: "C04",
  description: "",
  domain: "sound",
  instructions: "Compare candidates",
  policy: {
    requiredIndependentVotes: 1,
    blindToOthers: true,
    requiresReview: false,
  },
};
const textBlock = {
  id: "caption",
  type: "text",
  label: "Caption",
  required: true,
};
const setBlock = {
  id: "vote",
  type: "candidate_vote",
  label: "Select best",
  required: true,
  candidateSource: "set",
};
async function protocol(blocks, projectId = project) {
  const saved = await definitions.create(
    db,
    projectId,
    taskDraftSchema.parse({ ...common, blocks }),
  );
  await definitions.publish(db, saved.id, 1, 0);
  return saved.id;
}
async function task(
  definitionId,
  assetId = asset,
  sourceRecordId = "question",
  projectId = project,
) {
  return tasks.create(db, {
    projectId,
    definitionId,
    definitionVersion: 1,
    assetId,
    ...(sourceRecordId === null ? {} : { sourceRecordId }),
  });
}
async function job(task, actor = "voter") {
  return assignments.create(db, {
    projectId: task.projectId,
    taskInstanceId: task.id,
    labellerId: actor,
  });
}
async function submitSource(
  definitionId,
  sourceTask,
  actor,
  answers,
  status = "submitted",
) {
  const assignment = await job(sourceTask, actor);
  return annotations.save(
    db,
    assignment.id,
    { labellerId: actor, expectedRevision: 0, answers },
    status,
  );
}
const expects = (status) => (error) =>
  error instanceof CandidateSetError && error.status === status;

const { ingestDataset } = load("lib/backend/services/dataset-ingestion.ts");
const { resolveBoundBlocks } = load("lib/frontend/source-binding.ts");
const { validateAnswers } = load(
  "lib/backend/validation/annotation-answers.ts",
);
const { normalizeSourceChoices } = load("lib/frontend/choice-source.ts");
const React = require("react"),
  { renderToStaticMarkup } = require("react-dom/server");
const Fields = load("components/workbench/BlockFields.tsx").default;
(async () => {
  sqlite
    .prepare("INSERT INTO projects(id,name,slug) VALUES(?,?,?)")
    .run(project, "Batch bindings", project);
  sqlite
    .prepare("INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)")
    .run(dataset, project, "Questions", "1");
  for (const a of [asset, asset2])
    sqlite
      .prepare(
        "INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key) VALUES(?,?,?,'r2',?)",
      )
      .run(a, dataset, a + ".wav", a + ".wav");
  for (const [user, role] of [
    ["admin", "admin"],
    ["voter", "labeller"],
  ])
    await assignments.addMember(db, {
      projectId: project,
      userId: user,
      displayName: user,
      role,
    });
  const text = (value) => ({ type: "text", value, visibility: "worker" }),
    choice = (id, label) => ({ id, label });
  const raw = {
    schema_version: 1,
    dataset_id: dataset,
    source_version: "v1",
    provenance: { origin: "test", revision: "1" },
    records: [asset, asset2].map((id, i) => ({
      sample_id: "sample" + i,
      audio_id: id,
      items: [
        {
          item_id: "item",
          fields: {
            question: text(`Question ${i}`),
            caption: text(`Existing caption ${i}`),
            choices: {
              type: "choices",
              visibility: "worker",
              value: [
                choice(`first-${i}`, `First ${i}`),
                choice(`second-${i}`, `Second ${i}`),
              ],
            },
          },
        },
      ],
    })),
  };
  const imported = await ingestDataset(db, project, "admin", raw, true);
  assert(imported.ok);
  const sourceIds = imported.accepted.map((r) => r.source_record_id);
  const block = {
    id: "answer",
    type: "single_choice",
    label: "Question",
    required: true,
    numBatch: 2,
    allowCustom: true,
    answerAppearance: "exam",
    showSourceAnswer: true,
    sourceBindings: {
      label: { kind: "dataset", fieldId: "item.question", type: "string" },
      options: { kind: "dataset", fieldId: "item.choices", type: "choices" },
      preview: { kind: "dataset", fieldId: "item.caption", type: "string" },
    },
  };
  const textBlock = {
    id: "caption",
    type: "text",
    label: "Caption",
    required: true,
    numBatch: 2,
    sourceBindings: {
      value: {
        kind: "dataset",
        fieldId: "item.caption",
        type: "string",
        mode: "prefill",
      },
    },
  };
  assert(
    taskDraftSchema.safeParse({ ...common, blocks: [block, textBlock] })
      .success,
    "bound batches must save",
  );
  assert(
    !taskDraftSchema.safeParse({
      ...common,
      blocks: [{ ...block, batchBlocks: [] }],
    }).success,
    "cannot author runtime choices",
  );
  const def = await protocol([block, textBlock]);
  const t = await tasks.create(db, {
    projectId: project,
    definitionId: def,
    definitionVersion: 1,
    assetId: asset,
    audioAssetIds: [asset, asset2],
    sourceRecordId: sourceIds[0],
    sourceRecordIds: sourceIds,
  });
  assert.deepEqual(
    t.audioAssets.map((a) => a.id),
    [asset, asset2],
  );
  assert.deepEqual(
    t.resolvedDefinition.blocks[0].batchBlocks.map((b) => b.label),
    ["Question 0", "Question 1"],
  );
  assert.deepEqual(t.initialAnswers.caption, [
    "Existing caption 0",
    "Existing caption 1",
  ]);
  const j = await job(t);
  let answers = {
    answer: ["second-0", "first-1"],
    caption: t.initialAnswers.caption,
  };
  await assert.rejects(
    annotations.save(
      db,
      j.id,
      {
        labellerId: "voter",
        expectedRevision: 0,
        answers: { ...answers, answer: ["first-1", "first-0"] },
      },
      "draft",
    ),
    AnnotationAnswerError,
  );
  await annotations.save(
    db,
    j.id,
    { labellerId: "voter", expectedRevision: 0, answers },
    "draft",
  );
  answers = {
    ...answers,
    answer: [
      "second-0",
      { selection: "__custom__", customText: "Another class" },
    ],
  };
  await annotations.save(
    db,
    j.id,
    { labellerId: "voter", expectedRevision: 1, answers },
    "submitted",
  );
  assert.deepEqual(
    (await annotations.current(db, j.id, "voter")).current.answers,
    answers,
  );
  assert.deepEqual(
    (await tasks.get(db, t.id)).resolvedDefinition,
    t.resolvedDefinition,
  );
  const html = renderToStaticMarkup(
    React.createElement(Fields, {
      blocks: t.resolvedDefinition.blocks,
      answers,
      onChange: () => {},
      samples: { batchAudio: t.audioAssets },
    }),
  );
  for (const text of [
    "Question 0",
    "Question 1",
    "First 0",
    "First 1",
    "tb-choice-exam",
    "Your custom answer",
    "Existing source answer (read-only)",
    "Existing caption 1",
  ])
    assert(html.includes(text), text);
  const hidden = t.resolvedDefinition.blocks.map((b) => ({
    ...b,
    showSourceAnswer: false,
    batchBlocks: b.batchBlocks?.map((child) => ({
      ...child,
      showSourceAnswer: false,
    })),
  }));
  assert(
    !renderToStaticMarkup(
      React.createElement(Fields, {
        blocks: hidden,
        answers,
        onChange: () => {},
      }),
    ).includes("Existing source answer (read-only)"),
  );
  const definition = {
    ...common,
    id: def,
    version: 1,
    blocks: [
      {
        ...block,
        numBatch: 1,
        sourceBindings: undefined,
        options: [choice("a", "A"), choice("b", "B")],
      },
    ],
  };
  const valid = (v) =>
    validateAnswers(definition, { answer: v }, true).length === 0;
  assert(valid("a"));
  assert(valid({ selection: "__custom__", customText: "new" }));
  for (const invalid of [
    { selection: "__custom__", customText: "" },
    { selection: "__custom__", customText: 15 },
    { selection: "__custom__", customText: "x", extra: true },
    { selection: "a", customText: "stale" },
    { selection: "__custom__", customText: "x", children: { evil: "x" } },
  ])
    assert(!valid(invalid));
  definition.blocks[0].allowCustom = false;
  assert(!valid({ selection: "__custom__", customText: "no" }));
  definition.blocks[0] = {
    ...definition.blocks[0],
    type: "multiple_choice",
    allowCustom: true,
    maxSelections: 2,
  };
  assert(valid(["a", "b"]));
  assert(valid({ selection: ["a", "__custom__"], customText: "Other" }));
  assert(!valid(["a", "a"]));
  assert(!valid({ selection: ["a", "b", "__custom__"], customText: "Other" }));
  const importUI = load("components/task-builder/ChoiceJsonImport.tsx").default;
  assert(
    renderToStaticMarkup(
      React.createElement(importUI, { onImport: () => {} }),
    ).includes("Import JSON choices"),
  );
  const options = normalizeSourceChoices(
    JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({
        id: "class-" + i,
        label: "Class " + i,
      })),
    ),
    "json",
  );
  assert.equal(options.length, 50);
  assert.equal(options[49].id, "class-49");
  assert.throws(() =>
    normalizeSourceChoices(
      '[{"id":"same","label":"A"},{"id":"same","label":"B"}]',
      "json",
    ),
  );
  assert.throws(() =>
    normalizeSourceChoices(
      '[{"id":"__custom__","label":"A"},{"id":"b","label":"B"}]',
      "json",
    ),
  );
  const restricted = {
    ...block,
    numBatch: 1,
    sourceBindings: {
      preview: { kind: "dataset", fieldId: "reference_answer", type: "string" },
    },
  };
  assert(
    !taskDraftSchema.safeParse({ ...common, blocks: [restricted] }).success,
  );
  assert.throws(() =>
    resolveBoundBlocks(
      [
        {
          ...restricted,
          sourceBindings: {
            preview: {
              kind: "dataset",
              fieldId: "item.secret",
              type: "string",
            },
          },
        },
      ],
      { fields: [], audioUrl: "" },
    ),
  );
  const route = load("app/api/v1/labeller/audio-queue/route.ts");
  const params = new URLSearchParams({
    projectId: project,
    labellerId: "voter",
    datasetId: dataset,
    definitionId: def,
  });
  const response = await route.GET(
    new Request("http://localhost/api/v1/labeller/audio-queue?" + params),
  );
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.requiredAudio, 2);
  assert.equal(page.groups.length, 1);
  assert.equal(page.groups[0].assets.length, 2);
  assert.equal(page.groups[0].sourceRecordIds.length, 2);
  // Allocate/reopen through the real queue handler, with the server's ordered IDs.
  const group = page.groups[0];
  const body = {
    projectId: project,
    labellerId: "voter",
    datasetId: dataset,
    definitionId: def,
    definitionVersion: 1,
    assetIds: group.assets.map((a) => a.id),
    sourceRecordId: group.sourceRecordId,
    sourceRecordIds: group.sourceRecordIds,
  };
  const allocate = () =>
    route.POST(
      new Request("http://localhost/api/v1/labeller/audio-queue", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  const allocation = await allocate();
  assert.equal(
    allocation.status,
    200,
    JSON.stringify(await allocation.clone().json()),
  );
  const first = (await allocation.json()).assignment.id;
  assert.equal((await (await allocate()).json()).assignment.id, first);
  assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  console.log(
    "PASS ordered bound batches: independent questions/options, cross-panel rejection, prefills, draft/final/reopen, queue allocation",
  );
  console.log(
    "PASS JSON import (50 stable IDs), exam/batch SSR, custom single/multiple validation, explicit public answer preview and privacy",
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sqlite.close());
