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
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "audiolab-allocation-"),
);
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
const { assignmentService: assignments } = load(
  "lib/backend/services/assignments.ts",
);
const {
  annotationService: annotations,
  AnnotationAnswerError,
  AnnotationLabellerMismatchError,
} = load("lib/backend/services/annotations.ts");
const { ingestDataset } = load("lib/backend/services/dataset-ingestion.ts");
const { taskDraftSchema } = load("lib/backend/validation/task-definitions.ts");
const {
  allocationItems,
  previewAllocation,
  confirmAllocation,
  AllocationError,
} = load("lib/backend/services/assignment-allocation.ts");
const route = load("app/api/v1/assignment-allocation/route.ts");
const queue = load("app/api/v1/labeller/assigned-queue/route.ts");
const actor = "dev-admin",
  alice = "dev-alice",
  bob = "dev-bob",
  charlie = "dev-charlie";
const project = crypto.randomUUID(),
  dataset = crypto.randomUUID(),
  assetIds = [crypto.randomUUID(), crypto.randomUUID()];
const query = (who) =>
  new URLSearchParams({ projectId: project, labellerId: who, limit: "20" });
const getQueue = (who) =>
  queue.GET(
    new Request(
      "http://localhost/api/v1/labeller/assigned-queue?" + query(who),
    ),
  );
const post = (action, body, url = "http://localhost", headers = {}) =>
  route.POST(
    new Request(url + "/api/v1/assignment-allocation?action=" + action, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    }),
  );
(async () => {
  sqlite
    .prepare("INSERT INTO projects(id,name,slug) VALUES(?,?,?)")
    .run(project, "Assignment demo", project);
  sqlite
    .prepare("INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)")
    .run(dataset, project, "10 questions", "1");
  for (const id of assetIds)
    sqlite
      .prepare(
        "INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key) VALUES(?,?,?,'r2',?)",
      )
      .run(id, dataset, id + ".wav", id + ".wav");
  for (const [user, role] of [
    [actor, "admin"],
    [alice, "labeller"],
    [bob, "labeller"],
    [charlie, "labeller"],
  ])
    await assignments.addMember(db, {
      projectId: project,
      userId: user,
      displayName: user,
      role,
    });
  const field = (value) => ({ type: "text", visibility: "worker", value });
  const records = assetIds.map((asset, i) => ({
    sample_id: "sample-" + i,
    audio_id: asset,
    fields: { instruction: field("Instruction " + i) },
    items: Array.from({ length: 5 }, (_, j) => ({
      item_id: "question-" + (i * 5 + j),
      fields: {
        question: field("Question " + (i * 5 + j)),
        options: {
          type: "choices",
          visibility: "worker",
          value: [
            { id: "a-" + (i * 5 + j), label: "Alpha" },
            { id: "b-" + (i * 5 + j), label: "Beta" },
          ],
        },
      },
      reference: { field: "options", value: "a-" + (i * 5 + j) },
    })),
  }));
  const imported = await ingestDataset(
    db,
    project,
    actor,
    {
      schema_version: 1,
      dataset_id: dataset,
      source_version: "v1",
      provenance: { origin: "test", revision: "1" },
      records,
    },
    true,
  );
  assert(imported.ok);
  const draft = taskDraftSchema.parse({
    name: "Item question",
    description: "",
    domain: "sound",
    instructions: "Fallback",
    instructionBinding: {
      kind: "dataset",
      fieldId: "sample.instruction",
      type: "string",
    },
    policy: {
      requiredIndependentVotes: 2,
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
  const definition = await definitions.create(db, project, draft);
  await definitions.publish(db, definition.id, 1, 0);
  const items = (await allocationItems(db, project, actor, dataset)).items;
  assert.equal(items.length, 10);
  assert.equal(new Set(items.map((i) => i.assetId)).size, 2);
  const request = {
    projectId: project,
    adminId: actor,
    datasetId: dataset,
    definitionId: definition.id,
    definitionVersion: 1,
    itemKeys: items.map((i) => i.key),
    labellerIds: [alice, bob],
    independentLabellers: 2,
    mode: "fixed",
  };
  const previewResponse = await post("preview", request);
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).preview;
  assert.equal(preview.assignments, 20);
  assert.equal(preview.uniqueItems, 10);
  assert.equal(preview.newAssignments, 20);
  assert(preview.items.every((item) => item.question.startsWith("Question")));
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM assignments").get().n,
    0,
    "preview must not write",
  );
  const pairs = preview.pairs.map(({ itemKey, labellerId }) => ({
    itemKey,
    labellerId,
  }));
  const response = await post("confirm", { ...request, pairs });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.created, 20);
  assert.equal(
    (await (await post("confirm", { ...request, pairs })).json()).result
      .created,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM assignments").get().n,
    20,
  );
  for (const worker of [alice, bob]) {
    const result = await getQueue(worker);
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.groups.length, 10);
    assert.equal(body.totalPending, 10);
    assert(!JSON.stringify(body).includes("reference_answer"));
    assert.equal((await assignments.queue(db, project, worker)).length, 10);
  }
  const aliceJobs = (await (await getQueue(alice)).json()).groups,
    bobJobs = (await (await getQueue(bob)).json()).groups;
  const aliceJob = aliceJobs[0],
    detail = await assignments.detail(db, aliceJob.assignmentId);
  const matchingBob = bobJobs.find(
    (group) => group.sourceRecordId === aliceJob.sourceRecordId,
  );
  assert(matchingBob);
  assert.equal(
    detail.taskInstance.resolvedDefinition.instructions.startsWith(
      "Instruction",
    ),
    true,
  );
  const block = detail.taskInstance.resolvedDefinition.blocks[0];
  assert(block.label.startsWith("Question"));
  assert.equal(detail.taskInstance.audioAssets.length, 1);
  await assert.rejects(
    annotations.save(
      db,
      aliceJob.assignmentId,
      {
        labellerId: alice,
        expectedRevision: 0,
        answers: { answer: "not-a-choice" },
      },
      "submitted",
    ),
    AnnotationAnswerError,
  );
  for (const [worker, job, index] of [
    [alice, aliceJob, 0],
    [bob, matchingBob, 1],
  ]) {
    await annotations.save(
      db,
      job.assignmentId,
      {
        labellerId: worker,
        expectedRevision: 0,
        answers: { answer: block.options[index].id },
      },
      "draft",
    );
    await annotations.save(
      db,
      job.assignmentId,
      {
        labellerId: worker,
        expectedRevision: 1,
        answers: { answer: block.options[index].id },
      },
      "submitted",
    );
    assert.equal(
      (await annotations.current(db, job.assignmentId, worker)).current.answers
        .answer,
      block.options[index].id,
    );
    assert.equal((await (await getQueue(worker)).json()).totalSubmitted, 1);
    assert.equal((await (await getQueue(worker)).json()).totalPending, 9);
  }
  await assert.rejects(
    annotations.current(db, aliceJob.assignmentId, bob),
    AnnotationLabellerMismatchError,
  );
  assert.equal((await assignments.queue(db, project, alice)).length, 9);
  // No in-memory allocation state: reopen SQL and resolve again from persisted rows.
  sqlite.close();
  sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA foreign_keys=ON");
  assert.equal((await (await getQueue(alice)).json()).groups.length, 10);
  assert.equal(
    (await assignments.detail(db, aliceJob.assignmentId)).taskInstance
      .resolvedDefinition.blocks[0].label,
    block.label,
  );
  assert.equal(
    (await annotations.current(db, aliceJob.assignmentId, alice)).current
      .revision,
    2,
  );
  console.log(
    "PASS fixed panel: 10 source items (2 audios) × Alice/Bob = 20 persisted independent assignments; retry creates 0",
  );
  console.log(
    "PASS owner queue, dynamic question/choices/instructions, audio binding, invalid option rejection, independent draft/submit/reopen and status counts",
  );
  for (const patch of [
    { adminId: alice },
    { adminId: "spoof" },
    { datasetId: crypto.randomUUID() },
    { labellerIds: [alice, actor] },
    { definitionVersion: 99 },
    { independentLabellers: 3 },
    { itemKeys: [crypto.randomUUID()] },
  ])
    assert((await post("preview", { ...request, ...patch })).status >= 400);
  assert.equal(
    (await post("confirm", { ...request, pairs: [...pairs, pairs[0]] })).status,
    422,
  );
  assert.equal(
    (await post("confirm", { ...request, pairs: pairs.slice(1) })).status,
    422,
  );
  // Transport/identity gates moved to the mandatory proxy. Direct service/route
  // tests above retain all allocation validation. Production HTTP is exercised
  // by test_production_security.cjs through the built Vinext entrypoint.
  const { requireSameOrigin } = load("lib/backend/auth/identity.ts");
  assert.throws(() => requireSameOrigin(new Request("http://localhost/api/v1/assignment-allocation", {
    method:"POST",headers:{origin:"https://example.com"}
  }),{AUTH_MODE:"demo"}), error => error.status===403);
  const productionGuard=load("lib/backend/auth/api-guard.ts",false).authorizeApi;
  const productionRequest=new Request("https://audio.example/api/v1/assignment-allocation?action=preview",{
    method:"POST",headers:{"content-type":"application/json",origin:"https://audio.example"},body:JSON.stringify(request)
  });
  assert.equal((await productionGuard(db,productionRequest,{AUTH_MODE:"access",APP_ORIGIN:"https://audio.example",ACCESS_TEAM_DOMAIN:"https://test.cloudflareaccess.com",ACCESS_AUDIENCE:"test-app"})).status,401);
  assert.equal((await load("app/api/v1/assignment-allocation/route.ts",false).POST(new Request(
    "https://audio.example/api/v1/assignment-allocation?action=preview",{method:"POST",body:JSON.stringify(request)}))).status,200,
    "Authorized production routes no longer reject solely because DEV=false");
  assert.equal((await getQueue("unknown")).status, 403);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM assignments").get().n,
    20,
    "rejections cannot add jobs",
  );
  // A later version can allocate the same items independently. Balanced preview
  // uses actual outstanding workload; confirmations preserve its reviewed pairs.
  await definitions.update(db, definition.id, 1, draft);
  await definitions.publish(db, definition.id, 2, 1);
  const balanced = {
    ...request,
    definitionVersion: 2,
    mode: "balanced",
    labellerIds: [alice, bob, charlie],
  };
  const b = await previewAllocation(db, balanced);
  assert.equal(b.pairs.length, 20);
  for (const item of items)
    assert.equal(
      new Set(
        b.pairs.filter((p) => p.itemKey === item.key).map((p) => p.labellerId),
      ).size,
      2,
    );
  await confirmAllocation(db, balanced, b.pairs);
  const again = await previewAllocation(db, balanced);
  assert.deepEqual(
    again.pairs.map((p) => [p.itemKey, p.labellerId]).sort(),
    b.pairs.map((p) => [p.itemKey, p.labellerId]).sort(),
  );
  assert.equal((await confirmAllocation(db, balanced, b.pairs)).created, 0);
  // Concurrent retries still preserve each actual worker/task pair exactly once.
  const repeated = await Promise.all([
    confirmAllocation(db, balanced, b.pairs),
    confirmAllocation(db, balanced, b.pairs),
  ]);
  assert(repeated.every((result) => result.created === 0));
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM assignments").get().n,
    40,
  );
  assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  const React = require("react"),
    { renderToStaticMarkup } = require("react-dom/server");
  const Panel = load("components/admin/AssignmentAllocationPanel.tsx").default;
  const markup = renderToStaticMarkup(
    React.createElement(Panel, {
      projectId: project,
      members: await assignments.listMembers(db, project),
      datasets: [{ id: dataset, name: "Test" }],
      definitions: [
        { id: definition.id, name: "Question", publishedVersion: 2 },
      ],
      onAllocated: async () => {},
    }),
  );
  assert(markup.includes("Preview assignments"));
  assert(markup.includes("Fixed panel"));
  assert(markup.includes("dev-alice"));
  assert(markup.includes("Balanced"));
  console.log(
    "PASS membership/scope and local-origin/production guards, malformed pairs, balanced deterministic retry, concurrent duplicate prevention; UI SSR",
  );
  console.log("Disposable SQLite evidence:", filename);
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sqlite.close());
