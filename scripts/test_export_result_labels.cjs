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
const { taskDraftSchema } = load("lib/backend/validation/task-definitions.ts");
const { buildJobPlan, launchJob } = load("lib/backend/services/team-jobs.ts");
const { jobResults } = load("lib/backend/services/job-results.ts");
const { buildResearchExport, audioExportFile } = load(
  "lib/backend/services/research-export.ts",
);
const { readableBlockAnswer } = load("lib/contracts/readable-answers.ts");
const project = crypto.randomUUID(),
  dataset = crypto.randomUUID(),
  assets = Array.from({ length: 4 }, () => crypto.randomUUID());
const options = [
  { id: "uuid-left", label: "First sounds clearer" },
  { id: "uuid-right", label: "Second sounds clearer" },
  { id: "uuid-tie", label: "Equally clear" },
];
const comparison = {
  id: "compare",
  type: "audio_comparison",
  label: "Clarity comparison",
  required: true,
  numBatch: 4,
  comparisonSize: 2,
  stimulusSlots: ["A", "B"],
  options,
};
const choice = {
  id: "choice",
  type: "single_choice",
  label: "Sound",
  required: true,
  numBatch: 4,
  options: [
    { id: "uuid-bird", label: "Bird" },
    { id: "uuid-rain", label: "Rain" },
  ],
};
const rank = {
  id: "rank",
  type: "ranking",
  label: "Rank attributes",
  required: true,
  rankingMode: "labels",
  rankLabels: [
    { id: "uuid-clear", label: "Clarity" },
    { id: "uuid-natural", label: "Naturalness" },
  ],
};
(async () => {
  sqlite
    .prepare("INSERT INTO projects(id,name,slug) VALUES(?,?,?)")
    .run(project, "Result labels", project);
  sqlite
    .prepare("INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)")
    .run(dataset, project, "Audio", "1");
  for (const [index, id] of assets.entries())
    sqlite
      .prepare(
        "INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key,duration_seconds) VALUES(?,?,?,'r2',?,10)",
      )
      .run(id, dataset, "recording-" + index + ".wav", id);
  for (const [user, role] of [
    ["admin", "admin"],
    ["alice", "labeller"],
    ["bob", "labeller"],
  ]) {
    await assignments.addMember(db, {
      projectId: project,
      userId: user,
      displayName: user,
      role,
    });
    sqlite
      .prepare(
        "INSERT INTO auth_accounts(user_id,username,display_name) VALUES(?,?,?)",
      )
      .run(user, user, user);
  }
  const draft = taskDraftSchema.parse({
    name: "Read final answers",
    domain: "sound",
    description: "",
    instructions: "Compare each pair",
    policy: {
      requiredIndependentVotes: 2,
      blindToOthers: true,
      requiresReview: false,
    },
    blocks: [comparison, choice, rank],
  });
  const definition = await definitions.create(db, project, draft);
  await definitions.publish(db, definition.id, 1, 0);
  const input = {
    jobId: crypto.randomUUID(),
    projectId: project,
    name: "Readable results",
    datasetId: dataset,
    definitionId: definition.id,
    definitionVersion: 1,
    mode: "voting",
    seed: "labels",
    sampleCount: 4,
    itemKeys: assets.map((id) => "audio:" + id),
    workerIds: ["alice", "bob"],
  };
  const plan = await buildJobPlan(db, "admin", input),
    job = await launchJob(db, "admin", plan.input, plan.hash);
  for (const [index, user] of ["alice", "bob"].entries()) {
    const assignment = job.assignments.find((row) => row.userId === user);
    await annotations.save(
      db,
      assignment.id,
      {
        labellerId: user,
        expectedRevision: 0,
        answers: {
          compare: index
            ? ["uuid-left", "uuid-left"]
            : ["uuid-left", "uuid-right"],
          choice: Array(4).fill("uuid-bird"),
          rank: ["uuid-natural", "uuid-clear"],
        },
      },
      "submitted",
    );
    if (!index)
      assert.equal(
        (await jobResults(db, "admin", input.jobId)).complete,
        false,
      );
  }
  const results = await jobResults(db, "admin", input.jobId),
    result = results.blocks.find((block) => block.blockId === "compare");
  assert.equal(results.complete, true);
  assert.equal(result.type, "audio_comparison");
  assert.equal(result.comparisonGroups, 2);
  assert.equal(result.metric, "per-comparison exact agreement");
  assert.equal(result.meanSimilarity, 0.5);
  assert.equal(result.validComparisons, 2);
  assert.equal(result.unresolved, 0);
  assert.deepEqual(
    result.counts.map((row) => [row.label, row.count]),
    [
      ["First sounds clearer", 3],
      ["Second sounds clearer", 1],
      ["Equally clear", 0],
    ],
  );
  const data = await buildResearchExport(db, "admin", project, input.jobId),
    task = data.tasks[0],
    annotation = task.annotations[0];
  assert.equal(data.tasks.length, 1);
  assert.equal(task.annotations.length, 2);
  const readable = annotation.readableAnswers;
  assert.equal(readable.compare.value.length, 2);
  assert.equal(readable.compare.value[0].answer, "First sounds clearer");
  assert(
    readable.compare.value[1].recordings.every((label) =>
      label.endsWith(".wav"),
    ),
  );
  assert.deepEqual(readable.rank.value, ["Naturalness", "Clarity"]);
  assert.equal(readable.choice.value[0].answer, "Bird");
  assert.equal(JSON.stringify(readable).includes("uuid-"), false);
  assert.equal(annotation.answers.compare[0], "uuid-left");
  assert(annotation.revisionId);
  for (const audio of data.audioItems) {
    const projected = audio.sourceItems[0].blocks.find(
      (block) => block.block.id === "choice",
    );
    assert.equal(projected.annotations[0].readableValue, "Bird");
    assert(!("readableAnswers" in projected.annotations[0]));
    assert(
      audioExportFile(data, audio).taskInstances[0].annotations[0]
        .readableAnswers,
    );
  }
  assert.equal(
    task.distributions.filter((row) => row.blockId === "compare").length,
    2,
  );
  await assert.rejects(
    buildResearchExport(db, "alice", project, input.jobId),
    (error) => error.status === 403,
  );
  // Dynamic per-audio schemas may assign the same stable ID a different label.
  const dynamic = {
    ...choice,
    numBatch: 2,
    batchBlocks: [
      { ...choice, numBatch: 1 },
      {
        ...choice,
        numBatch: 1,
        options: [{ id: "uuid-bird", label: "Speech" }],
      },
    ],
  };
  assert.deepEqual(
    readableBlockAnswer(dynamic, ["uuid-bird", "uuid-bird"], ["a", "b"]).map(
      (row) => row.answer,
    ),
    ["Bird", "Speech"],
  );
  assert.equal(
    readableBlockAnswer(choice.options ? { ...choice, numBatch: 1 } : choice, {
      selection: "__custom__",
      customText: "A custom sound",
    }),
    "A custom sound",
  );
  assert.deepEqual(
    readableBlockAnswer(
      { ...rank, rankingMode: "audios" },
      ["slot-1", "slot-0"],
      ["first.wav", "second.wav"],
    ),
    ["second.wav", "first.wav"],
  );
  assert.deepEqual(
    readableBlockAnswer(
      { ...choice, type: "multiple_choice", numBatch: 1 },
      { selection: ["uuid-bird", "__custom__"], customText: "Other sound" },
    ),
    ["Bird", "Other sound"],
  );
  const repeated = {
    id: "group",
    label: "Repeated",
    type: "repeated_group",
    required: false,
    blocks: [{ ...choice, numBatch: 1 }],
  };
  assert.equal(
    readableBlockAnswer(repeated, [
      { id: "entry-uuid", answers: { choice: "uuid-bird" } },
    ])[0].answers[0].answer,
    "Bird",
  );
  const React = require("react"),
    { renderToStaticMarkup } = require("react-dom/server");
  const { ExportComparisonPreview, ExportRankingPreview } = load(
    "components/admin/ResearchExportWorkspace.tsx",
  );
  const html = renderToStaticMarkup(
    React.createElement(ExportComparisonPreview, {
      block: comparison,
      value: ["uuid-left", "uuid-right"],
      task,
    }),
  );
  assert(html.includes("First sounds clearer"));
  assert(html.includes("Second sounds clearer"));
  assert(html.includes("Comparison 2"));
  assert.equal((html.match(/<audio /g) || []).length, 4);
  assert(!html.includes("uuid-"));
  assert(!html.includes("<button"));
  const ranking = renderToStaticMarkup(
    React.createElement(ExportRankingPreview, {
      block: rank,
      value: ["uuid-natural", "uuid-clear"],
      task,
    }),
  );
  assert(!ranking.includes("uuid-"));
  assert(ranking.indexOf("Naturalness") < ranking.indexOf("Clarity"));
  const { ReadableAnnotation } = load(
    "components/admin/ReadableAnnotation.tsx",
  );
  const choiceHtml = renderToStaticMarkup(
    React.createElement(ReadableAnnotation, {
      block: dynamic,
      value: ["uuid-bird", "uuid-bird"],
    }),
  );
  assert(choiceHtml.includes("Bird") && choiceHtml.includes("Speech"));
  assert(!choiceHtml.includes("uuid-"));
  assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  sqlite.close();
  console.log(
    "PASS readable export + comparison final stats: real publish/job/independent submissions, labels with raw provenance retained, per-audio and task exports, dynamic labels, custom/ranking/repeated answers, zero-count options, 50% group agreement, completion/privacy gates and noninteractive comparison SSR. Disposable SQLite: " +
      filename,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
