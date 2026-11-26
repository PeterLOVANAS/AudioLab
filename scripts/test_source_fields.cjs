// Two synthetic MMAU records, using the repository migrations and the real resolver.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const ts = require("@typescript/typescript6");
const root = path.resolve(__dirname, "..");
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=ON");
for (const migration of ["0001_catalog.sql", "0002_audio_assets.sql", "0003_source_records.sql", "0006_assignments.sql", "0014_canonical_ingestion.sql"])
  db.exec(fs.readFileSync(path.join(root, "migrations", migration), "utf8"));

const project = "11111111-1111-4111-8111-111111111111";
const otherProject = "22222222-2222-4222-8222-222222222222";
const dataset = "33333333-3333-4333-8333-333333333333";
const otherDataset = "44444444-4444-4444-8444-444444444444";
for (const [p, d] of [[project, dataset], [otherProject, otherDataset]]) {
  db.prepare("INSERT INTO projects(id,name,slug) VALUES(?,?,?)").run(p, p, p);
  db.prepare("INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)").run(d, p, "MMAU", "1");
}
db.prepare("INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,?)")
  .run(project, "admin", "Admin", "admin");
db.prepare("INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,?)")
  .run(project, "worker", "Worker", "labeller");
for (const [index, d, answer] of [[1, dataset, "SECRET_ONE"], [2, dataset, "SECRET_TWO"], [3, otherDataset, "OTHER_SECRET"]]) {
  const asset = `asset-${index}`, source = `${asset}::mmau-${index}`;
  db.prepare(`INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key)
    VALUES(?,?,?,'r2',?)`).run(asset, d, `audio-${index}.wav`, `audio-${index}.wav`);
  db.prepare(`INSERT INTO source_records(id,asset_id,source_record_id,source_domain,question,choices_json)
    VALUES(?,?,?,'sound',?,?)`).run(source, asset, `mmau-${index}`, `Question ${index}`,
    JSON.stringify(["A", "B", "C", `D${index}`]));
  db.prepare(`INSERT INTO source_labels(id,source_record_id,kind,payload_json,provenance)
    VALUES(?,?,'reference_answer',?,'imported_source_answer')`).run(`${source}::answer`, source, JSON.stringify({ value: answer }));
  db.prepare(`INSERT INTO source_labels(id,source_record_id,kind,payload_json,provenance)
    VALUES(?,?,'early_annotation',?,'imported_early_annotation')`)
    .run(`${source}::early`, source, JSON.stringify({ nested: { identity: `PRIVATE_${index}`, answer } }));
}
const cache = new Map();
function load(relative, dev = true) {
  const key = `${dev}:${relative}`;
  if (cache.has(key)) return cache.get(key).exports;
  const file = path.join(root, relative + ".ts");
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file,
  }).outputText;
  const module = { exports: {} }; cache.set(key, module);
  new Function("require", "module", "exports", output.replaceAll("import.meta.env.DEV", String(dev)))((name) => {
    if (name === "cloudflare:workers") return { env: { DB: d1 } };
    return name.startsWith("@/") ? load(name.slice(2), dev) : require(name);
  }, module, module.exports);
  return module.exports;
}
const { resolveSourceFields, SourceFieldDataError } = load("lib/backend/services/source-fields");
const { resolveBoundBlocks } = load("lib/frontend/source-binding");
let labelReads = 0;
const d1 = { prepare(sql) {
  if (sql.includes("FROM source_labels")) labelReads++;
  return { bind(...args) {
  return { async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; } };
} }; } };
const admin = { projectId: project, userId: "admin", role: "admin" };
const worker = { projectId: project, userId: "worker", role: "labeller" };
(async () => {
  // Metadata is deliberately adversarial: no key-name blacklist can safely
  // sanitize arbitrary nested import data for workers.
  const metadata = { split: "test", nested: { answer: "METADATA_SECRET" } };
  db.prepare("UPDATE source_records SET metadata_json=?,updated_at='2026-01-01 00:00:00'")
    .run(JSON.stringify(metadata));
  for (const index of [1, 2]) {
    const record = `mmau-${index}`;
    const preview = await resolveSourceFields(d1, admin, dataset, record, "admin");
    const payload = await resolveSourceFields(d1, worker, dataset, record, "worker");
    assert.equal(preview.recordId, record);
    const metadataField = preview.fields.find(({ field }) => field.id === "metadata");
    assert.deepEqual(metadataField.value, metadata);
    assert.equal(metadataField.field.visibility, "admin");
    assert.equal(metadataField.provenance.sourceUpdatedAt, "2026-01-01 00:00:00");
    const label = preview.fields.find(({ field }) => field.id === "early_annotation");
    assert.equal(label.provenance.recordId, record);
    assert(label.provenance.labelId && label.provenance.labelUpdatedAt);
    assert.equal(preview.audio.assetId, `asset-${index}`);
    assert.equal(preview.fields.find(({field}) => field.id === "question").value, `Question ${index}`);
    assert.deepEqual(preview.fields.find(({field}) => field.id === "choices").value, ["A", "B", "C", `D${index}`]);
    assert.equal(preview.fields.find(({field}) => field.id === "early_annotation").provenance.sourceRecordId,
      `asset-${index}::${record}`);
    assert.equal(preview.fields.find(({field}) => field.id === "reference_answer").value.value, `SECRET_${index === 1 ? "ONE" : "TWO"}`);
    assert.deepEqual(payload.fields.map(({field}) => field.id), ["question", "choices"]);
    const bound = { id: "bound", type: "single_choice", label: "Static", required: true,
      sourceBindings: {
        label: { kind: "dataset", fieldId: "question", type: "string" },
        options: { kind: "dataset", fieldId: "choices", type: "string[]" },
      } };
    for (const sample of [preview, payload]) {
      const rendered = resolveBoundBlocks([bound], sample)[0];
      assert.equal(rendered.label, `Question ${index}`);
      assert.deepEqual(rendered.options.map(option => option.label), ["A", "B", "C", `D${index}`]);
      assert(!JSON.stringify(rendered).includes("SECRET"));
      assert(!JSON.stringify(rendered).includes("PRIVATE"));
    }
    assert.equal(bound.label, "Static", "Preview does not mutate the authored definition");
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["SECRET_", "PRIVATE_", "METADATA_SECRET", "metadata", "reference_answer", "early_annotation", record, "sourceRecordId", "labelId"])
      assert.equal(serialized.includes(forbidden), false, forbidden);
    console.log(`PASS records/privacy ${record}: admin fields=${preview.fields.map(({field})=>field.id).join(",")}; worker fields=${payload.fields.map(({field})=>field.id).join(",")}; provenance=[redacted]`);
  }
  assert.equal(await resolveSourceFields(d1, admin, dataset, "missing", "admin"), null);
  assert.equal(await resolveSourceFields(d1, admin, otherDataset, "mmau-3", "admin"), null);
  assert.equal(await resolveSourceFields(d1, worker, dataset, "mmau-1", "admin"), null);
  assert.equal(await resolveSourceFields(d1, { ...admin, userId: "missing" }, dataset, "mmau-1", "admin"), null);
  assert.equal(await resolveSourceFields(d1, { ...worker, role: "admin" }, dataset, "mmau-1", "admin"), null);
  console.log("PASS missing/out-of-project/role: Source unavailable; no foreign record");

  // Repeat one external ID on a second recording, as permitted by migration
  // 0003. Legacy calls fail closed, while the selected asset resolves exactly.
  db.prepare(`INSERT INTO source_records(id,asset_id,source_record_id,source_domain,question,choices_json)
    VALUES('duplicate','asset-2','mmau-1','sound','Other recording',?)`)
    .run(JSON.stringify(["one", "two", "three", "four"]));
  assert.equal(await resolveSourceFields(d1, admin, dataset, "mmau-1", "admin"), null);
  const selected = await resolveSourceFields(d1, admin, dataset, "mmau-1", "admin", "asset-1");
  assert.equal(selected.audio.assetId, "asset-1");
  assert.equal(selected.fields.find(({field}) => field.id === "question").value, "Question 1");
  assert.equal((await resolveSourceFields(d1, admin, dataset, "mmau-1", "admin", "asset-2"))
    .fields.find(({field}) => field.id === "question").value, "Other recording");
  assert.equal(await resolveSourceFields(d1, admin, dataset, "mmau-1", "admin", "asset-3"), null);
  assert.equal(await resolveSourceFields(d1, admin, otherDataset, "mmau-3", "admin", "asset-3"), null);
  const beforeWorker = labelReads;
  await resolveSourceFields(d1, worker, dataset, "mmau-1", "worker", "asset-1");
  assert.equal(labelReads, beforeWorker, "Workers never query original labels");
  console.log("PASS duplicate external IDs resolve only with matching asset; project/dataset scope preserved");

  const originalLabels = db.prepare("SELECT * FROM source_labels ORDER BY id").all();
  const missingFields = await resolveSourceFields(d1, admin, dataset, "mmau-1", "admin", "asset-2");
  assert.equal(missingFields.fields.some(({ field }) => field.provenance === "source_labels"), false);
  db.prepare("UPDATE source_records SET question=NULL,choices_json=? WHERE id='duplicate'")
    .run(JSON.stringify(["A", 42, "C", "D"]));
  const incomplete = await resolveSourceFields(d1, worker, dataset, "mmau-1", "worker", "asset-2");
  assert.deepEqual(incomplete.fields, []);
  // Invalid restricted JSON cannot break worker reads, and errors must not echo
  // hidden contents into route logs. Labels stay independent of worker results.
  db.prepare("UPDATE source_labels SET payload_json=? WHERE id=?")
    .run('MALFORMED_SECRET', 'asset-1::mmau-1::answer');
  await resolveSourceFields(d1, worker, dataset, "mmau-1", "worker", "asset-1");
  await assert.rejects(resolveSourceFields(d1, admin, dataset, "mmau-1", "admin", "asset-1"),
    error => error instanceof SourceFieldDataError && !error.message.includes("MALFORMED_SECRET"));
  db.prepare("UPDATE source_labels SET payload_json=? WHERE id=?")
    .run(originalLabels.find(row => row.id === 'asset-1::mmau-1::answer').payload_json, 'asset-1::mmau-1::answer');
  db.prepare("UPDATE source_records SET metadata_json=? WHERE id='asset-1::mmau-1'").run('PRIVATE_BAD_METADATA');
  await resolveSourceFields(d1, worker, dataset, "mmau-1", "worker", "asset-1");
  await assert.rejects(resolveSourceFields(d1, admin, dataset, "mmau-1", "admin", "asset-1"),
    error => error instanceof SourceFieldDataError && !error.message.includes("PRIVATE_BAD_METADATA"));
  db.prepare("UPDATE source_records SET metadata_json=? WHERE id='asset-1::mmau-1'").run(JSON.stringify(metadata));
  assert.deepEqual(db.prepare("SELECT * FROM source_labels ORDER BY id").all(), originalLabels);
  console.log("PASS missing/wrong-type fields, malformed restricted JSON isolation, redacted errors and untouched labels");

  // Exercise the actual GET handler with the test D1 binding. DEV is injected
  // by this in-memory transpiler only; production remains gated in source.
  const { GET } = load("app/api/v1/source-fields/route");
  async function request(patch, expected) {
    const query = new URLSearchParams({ projectId: project, datasetId: dataset,
      recordId: "mmau-1", assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "admin", view: "admin", ...patch });
    // Unit fixtures intentionally have opaque asset IDs, so omit this optional
    // UUID filter when testing legacy route compatibility.
    if (patch.assetId === undefined) query.delete("assetId");
    const response = await GET(new Request(`http://localhost/api/v1/source-fields?${query}`));
    assert.equal(response.status, expected);
    return response.json();
  }
  await request({ recordId: "mmau-2" }, 200);
  await request({ projectId: "bad" }, 400);
  await request({ userId: "" }, 400);
  await request({ userId: "x".repeat(129) }, 400);
  await request({ recordId: "x".repeat(201) }, 400);
  await request({ assetId: "bad" }, 400);
  await request({ assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, 404);
  await request({ recordId: "missing" }, 404);
  await request({ userId: "worker" }, 404);
  await request({ datasetId: otherDataset, recordId: "mmau-3" }, 404);
  await request({ recordId: "mmau-1" }, 404); // ambiguous legacy lookup
  const workerRoute = await request({ userId: "worker", view: "worker", recordId: "mmau-2" }, 200);
  assert.deepEqual(workerRoute.source.fields.map(({field}) => field.id), ["question", "choices"]);
  const publicAsset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  db.prepare(`INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key)
    VALUES(?,?,?,'r2',?)`).run(publicAsset, dataset, 'public.wav', 'public.wav');
  db.prepare(`INSERT INTO source_records(id,asset_id,source_record_id,source_domain,question,metadata_json)
    VALUES(?,?,?,'sound','Public question',?)`).run('public-source', publicAsset, 'public-record', JSON.stringify(metadata));
  const legacyRoute = load("app/api/v1/source-records/route");
  const publicResponse = await legacyRoute.GET(new Request(`http://localhost/api/v1/source-records?assetId=${publicAsset}`));
  assert.equal(publicResponse.status, 200);
  const publicBody = await publicResponse.json();
  assert.deepEqual(publicBody.sourceRecords[0].metadata, {});
  assert(!JSON.stringify(publicBody).includes("METADATA_SECRET"));
  const denied = await load("app/api/v1/source-fields/route", false).GET(new Request('http://localhost/api/v1/source-fields'));
  assert.equal(denied.status, 400); // Handler parsing; production auth is verified at the real proxy boundary.
  console.log("PASS actual GET handler: 200 projections, 400 malformed inputs, uniform 404 denied/missing/ambiguous, production-mode parsing and legacy metadata privacy");
  db.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
