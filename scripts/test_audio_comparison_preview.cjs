/** Server-rendered control contract only; no browser/audio decoding involved. */
const fs = require("node:fs"),
  path = require("node:path"),
  ts = require("@typescript/typescript6"),
  assert = require("node:assert/strict");
const root = process.cwd(),
  cache = new Map();
function load(file) {
  file = path.resolve(root, file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const code = ts
    .transpileModule(fs.readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    })
    .outputText.replaceAll("import.meta.env.DEV", "true");
  new Function("require", "module", "exports", code)(
    (name) => {
      if (name.endsWith(".css")) return {};
      if (!name.startsWith("@/") && !name.startsWith(".")) return require(name);
      const base = name.startsWith("@/")
        ? path.resolve(root, name.slice(2))
        : path.resolve(path.dirname(file), name);
      const target = [
        base,
        base + ".ts",
        base + ".tsx",
        path.join(base, "index.ts"),
      ].find(
        (candidate) =>
          fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
      );
      if (!target) throw Error(name);
      return load(target);
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}

const { loadSourcePreviewBatch } = load("lib/frontend/source-preview.ts");
const { resolveBoundBatchBlocks } = load("lib/frontend/source-binding.ts");
const { requiredTaskRecordings } = load("lib/contracts/task-batches.ts");
const React = require("react"),
  { renderToStaticMarkup } = require("react-dom/server");
const records = {
  a: [{ sourceRecordId: "same", question: "First question" }],
  b: [
    { sourceRecordId: "same", question: "Second recording question" },
    { sourceRecordId: "alternate", question: "Alternative question" },
  ],
  c: [],
};
const calls = [];
const reader = async (route, signal) => {
  calls.push(route);
  assert.equal(signal, controller.signal);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const url = new URL("http://test/" + route),
    asset = url.searchParams.get("assetId"),
    id = url.searchParams.get("recordId");
  if (url.pathname === "/source-records")
    return { sourceRecords: records[asset] };
  assert.equal(url.pathname, "/source-fields");
  assert.equal(url.searchParams.get("projectId"), "project");
  assert.equal(url.searchParams.get("datasetId"), "dataset");
  assert.equal(url.searchParams.get("userId"), "current-member");
  assert.equal(url.searchParams.get("view"), "worker");
  assert(records[asset].some((record) => record.sourceRecordId === id));
  return {
    source: {
      fields: [
        {
          field: {
            id: "question",
            type: "string",
            visibility: "worker",
            provenance: "source_records",
          },
          value: `${asset}/${id}`,
        },
      ],
    },
  };
};
const controller = new AbortController();
const input = {
  projectId: "project",
  datasetId: "dataset",
  memberId: "current-member",
  access: "worker",
  assets: ["a", "b", "c"].map((id) => ({ id, originalPath: id + ".wav" })),
  assetId: "a",
  recordId: "same",
  count: 2,
  selectedRecords: {},
};
(async () => {
  let result = await loadSourcePreviewBatch(input, reader, controller.signal);
  assert.deepEqual(
    result.samples.map((sample) => sample.recordId),
    ["same", "same"],
  );
  assert.equal(result.slots[1].records.length, 2);
  assert.deepEqual(
    result.samples.map((sample) => sample.audio.assetId),
    ["a", "b"],
  );
  assert.equal(
    result.samples[1].fields[0].value,
    "b/same",
    "same external item ID cannot borrow first audio fields",
  );
  result = await loadSourcePreviewBatch(
    { ...input, selectedRecords: { b: "alternate" } },
    reader,
    controller.signal,
  );
  assert.equal(result.samples[1].fields[0].value, "b/alternate");
  const blocks = [
    {
      id: "question",
      type: "single_choice",
      numBatch: 2,
      label: "Manual",
      sourceBindings: {
        label: {
          kind: "dataset",
          fieldId: "question",
          type: "string",
          mode: "read_only",
        },
      },
      options: [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ],
    },
  ];
  assert.deepEqual(
    resolveBoundBatchBlocks(blocks, result.samples)[0].batchBlocks.map(
      (block) => block.label,
    ),
    ["a/same", "b/alternate"],
  );
  const before = JSON.stringify(input);
  result = await loadSourcePreviewBatch(
    { ...input, assetId: "b", recordId: "alternate", count: 3 },
    reader,
    controller.signal,
  );
  assert.deepEqual(
    result.samples.map((sample) => sample.audio.assetId),
    ["b", "c", "a"],
  );
  assert.equal(result.samples[1].recordId, "");
  assert.deepEqual(result.samples[1].fields, []);
  assert.equal(result.samples[1].audioUrl, "/api/v1/assets/c/audio");
  assert.equal(JSON.stringify(input), before);
  assert(
    !calls.some(
      (call) =>
        call.startsWith("source-fields?") &&
        new URL("http://test/" + call).searchParams.get("assetId") === "c",
    ),
    "recordless audio never requests invented source identity",
  );
  await assert.rejects(
    loadSourcePreviewBatch(
      { ...input, selectedRecords: { b: "missing" } },
      reader,
      controller.signal,
    ),
    /no longer available/,
  );
  await assert.rejects(
    loadSourcePreviewBatch({ ...input, count: 4 }, reader, controller.signal),
    /4 distinct/,
  );
  assert.equal(requiredTaskRecordings([{ type: "audio_comparison" }]), 2);
  assert.equal(
    requiredTaskRecordings([
      { type: "ranking", stimulusSlots: ["A", "B", "C"] },
    ]),
    3,
  );
  controller.abort();
  await assert.rejects(
    loadSourcePreviewBatch(input, reader, controller.signal),
    (e) => e.name === "AbortError",
  );
  const Fields = load("components/workbench/BlockFields.tsx").default;
  const html = renderToStaticMarkup(
    React.createElement(Fields, {
      blocks: [
        {
          id: "compare",
          type: "audio_comparison",
          label: "Compare",
          numBatch: 2,
          comparisonSize: 2,
          options: [
            { id: "first", label: "First" },
            { id: "second", label: "Second" },
          ],
        },
      ],
      answers: {},
      onChange() {},
      samples: {
        batchAudio: result.samples
          .slice(0, 2)
          .map((sample) => ({
            id: sample.audio.assetId,
            url: sample.audio.url,
            label: sample.audio.assetId,
          })),
      },
    }),
  );
  assert(html.includes("/api/v1/assets/b/audio"));
  assert(html.includes("/api/v1/assets/c/audio"));
  const Builder = load("components/task-builder/TaskBuilder.tsx").default;
  const builder = renderToStaticMarkup(
    React.createElement(Builder, { onDirty() {} }),
  );
  assert(!builder.includes("Labeller audio tools"));
  assert(!builder.includes("02 / AUDIO WORKSPACE"));
  assert(builder.includes("02 / COMPOSITION"));
  console.log(
    "PASS audio comparison preview: multi-question selection, same IDs on different audio, alternate item binding, recordless audio, ordered wraparound, insufficient/stale/aborted errors, comparison audio SSR and removed audio-tools panel. No browser or DB.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
