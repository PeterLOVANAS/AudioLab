/** R02A exact-value analytics and SSR tests; no network or preserved database. */
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  ts = require("@typescript/typescript6");
const root = path.resolve(__dirname, ".."),
  cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative).exports;
  const filename = path.join(root, relative),
    mod = { exports: {} };
  cache.set(relative, mod);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  new Function("require", "module", "exports", code)(
    (name) => {
      if (name.endsWith(".css")) return {};
      if (name.startsWith("@/") || name.startsWith(".")) {
        const base = name.startsWith("@/")
          ? name.slice(2)
          : path.relative(root, path.resolve(path.dirname(filename), name));
        return load(
          base +
            (fs.existsSync(path.join(root, base + ".ts")) ? ".ts" : ".tsx"),
        );
      }
      return require(name);
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}
const { validateAnswers } = load(
  "lib/backend/validation/annotation-answers.ts",
);
const { taskBatchDefinition } = load("lib/contracts/task-batch-definition.ts");
const { taskDraftSchema } = load("lib/backend/validation/task-definitions.ts");
const { resultDistribution, referenceEvaluation } = load(
  "lib/backend/services/result-distributions.ts",
);
const { resolveTaskInputs } = load("lib/backend/services/task-inputs.ts");
const { originalChoiceValue } = load("lib/contracts/source-reference.ts");
assert.equal(
  originalChoiceValue({ value: "Alpha", private: "must not release" }),
  "Alpha",
);
assert.equal(originalChoiceValue({ value: { private: "bad" } }), null);
const { resolveBoundBlocks } = load("lib/frontend/source-binding.ts");
const base = {
  id: "definition",
  version: 1,
  name: "MMAU-style task",
  description: "",
  domain: "sound",
  instructions: "Listen",
  policy: {
    requiredIndependentVotes: 3,
    blindToOthers: true,
    requiresReview: false,
  },
};
const { id: ignoredId, version: ignoredVersion, ...draftBase } = base;
const ground = {
  id: "aid",
  type: "timeline_annotation",
  label: "Optional aid",
  required: false,
  groundingMode: "flexible",
  tiers: [
    {
      id: "words",
      name: "Words",
      kind: "interval",
      allowOverlap: true,
      labelMode: "text",
    },
    {
      id: "phones",
      name: "Phones",
      kind: "interval",
      allowOverlap: true,
      labelMode: "ipa",
    },
    {
      id: "events",
      name: "Sounds",
      kind: "interval",
      allowOverlap: true,
      labelMode: "text",
    },
  ],
};
const choice = {
  id: "choice",
  type: "single_choice",
  label: "Question",
  required: true,
  numBatch: 4,
  options: [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ],
  sourceBindings: {
    options: {
      kind: "dataset",
      fieldId: "choices",
      type: "string[]",
      format: "array",
    },
  },
};
const def = taskBatchDefinition({ ...base, blocks: [choice, ground] }, 4),
  ctx = { audioAssetCount: 4 };
assert.deepEqual(
  validateAnswers(def, { choice: ["a", "b", "a", "b"] }, true, ctx),
  [],
);
assert.deepEqual(validateAnswers(def, {}, false, ctx), []);
for (const aid of [
  [],
  [null],
  [null, { tiers: { words: [], phones: [], events: [] } }],
])
  assert.deepEqual(
    validateAnswers(def, { choice: ["a", "b", "a", "b"], aid }, true, ctx),
    [],
  );
for (const aid of [
  null,
  "bad",
  [{}, null, null, null],
  [null, null, null, null, null],
  [{ tiers: { unpublished: [] } }],
  [
    {
      tiers: {
        words: [{ id: "bad", start: 3, end: 1, text: "bad" }],
        phones: [],
        events: [],
      },
    },
  ],
])
  assert(
    validateAnswers(def, { choice: ["a", "b", "a", "b"], aid }, true, ctx)
      .length,
  );
const required = taskBatchDefinition(
  { ...base, blocks: [{ ...ground, required: true }] },
  4,
);
assert(validateAnswers(required, {}, true, ctx).length);
assert(
  validateAnswers(required, { aid: [null, null, null, null] }, true, ctx)
    .length,
);
assert(
  validateAnswers({ ...base, blocks: [choice] }, { choice: ["a"] }, true, ctx)
    .length,
);
const answer = {
  tiers: {
    words: [],
    phones: [{ id: "phone", start: 1, end: 2, text: "a" }],
    events: [],
  },
};
assert.deepEqual(
  validateAnswers(
    required,
    { aid: [answer, answer, answer, answer] },
    true,
    ctx,
  ),
  [],
);
const observations = ["a", "a", "b", null].map((value, i) => ({
  workerId: "w" + i,
  displayName: "Worker " + i,
  assignmentId: "a" + i,
  revisionId: "r" + i,
  value,
  readable: value,
  state: value === null ? "missing" : "valid",
}));
const item = {
  ...base,
  key: "question-one",
  taskInstanceId: "task-one",
  definitionId: base.id,
  definitionVersion: 1,
  sourceKeys: ["source-one"],
  blockId: choice.id,
  path: choice.id,
  block: { ...choice, numBatch: 1 },
  audio: [{ id: "audio1", url: "/audio1", label: "one.wav", duration: 10 }],
  observations,
  tracks: [],
  pairs: [],
  mean: 1 / 3,
  min: 0,
  max: 1,
  validObservations: 3,
  excludedObservations: 1,
  eligiblePairs: 3,
  excludedPairs: 3,
  absencePairs: 0,
  metric: "exact agreement",
  numeric: null,
};
item.distribution = resultDistribution(item);
assert.deepEqual(
  item.distribution.counts.map((c) => c.count),
  [2, 1],
);
item.reference = referenceEvaluation(item.block, observations, [
  { value: "Alpha" },
]);
assert.deepEqual(
  item.reference.observations.map((o) => o.match),
  [true, true, false, null],
);
assert(
  !JSON.stringify(item.reference).includes("Alpha"),
  "Raw private reference is not serialized",
);
assert(
  !referenceEvaluation(
    {
      ...item.block,
      options: [
        { id: "a", label: "Same" },
        { id: "b", label: "Same" },
      ],
    },
    observations,
    [{ value: "Same" }],
  ).available,
);
assert(
  !referenceEvaluation(item.block, observations, [{ value: "no match" }])
    .available,
);
assert(
  !referenceEvaluation(item.block, observations, [
    { value: "Alpha" },
    { value: "Alpha" },
  ]).available,
);
assert(
  !referenceEvaluation(
    { ...item.block, sourceBindings: undefined },
    observations,
    [{ value: "Alpha" }],
  ).available,
);
const other = {
  ...item,
  block: {
    ...item.block,
    label: "Different question",
    options: [
      { id: "a", label: "Gamma" },
      { id: "b", label: "Delta" },
    ],
  },
};
assert.equal(resultDistribution(other).counts[0].label, "Gamma");
const ranking = {
  ...item,
  block: {
    id: "rank",
    label: "Rank",
    type: "ranking",
    required: true,
    rankingMode: "audios",
    stimulusSlots: ["first", "second"],
  },
  audio: [...item.audio, { ...item.audio[0], id: "audio2", label: "two.wav" }],
  observations: observations.slice(0, 3).map((o, i) => ({
    ...o,
    value: i === 2 ? ["slot-1", "slot-0"] : ["slot-0", "slot-1"],
  })),
};
ranking.distribution = resultDistribution(ranking);
assert.deepEqual(
  ranking.distribution.ranks.map((r) => r.positions),
  [
    [2, 1],
    [1, 2],
  ],
);
const multi = {
  ...item,
  block: {
    ...item.block,
    type: "multiple_choice",
    answerAppearance: "checkbox-grid",
  },
  observations: observations
    .slice(0, 2)
    .map((o, i) => ({ ...o, value: i ? ["b"] : ["a", "b"] })),
};
assert.deepEqual(
  resultDistribution(multi).counts.map((c) => c.count),
  [1, 2],
);
assert(
  taskDraftSchema.safeParse({ ...draftBase, blocks: [multi.block] }).success,
  JSON.stringify(
    taskDraftSchema.safeParse({ ...draftBase, blocks: [multi.block] }).error
      ?.issues,
  ),
);
const training = {
  ...choice,
  numBatch: 1,
  trainingAnswerPreview: true,
  showSourceAnswer: true,
  sourceBindings: {
    ...choice.sourceBindings,
    preview: { kind: "dataset", fieldId: "reference_answer", type: "json" },
  },
};
assert(taskDraftSchema.safeParse({ ...draftBase, blocks: [training] }).success);
assert(
  !taskDraftSchema.safeParse({
    ...draftBase,
    blocks: [{ ...training, trainingAnswerPreview: false }],
  }).success,
);
// The block inspector already opted in, but the full Builder preview used
// the worker-only mapper directly and reproduced the protected-answer error.
const adminSample = {
  projectId: "project",
  datasetId: "dataset",
  recordId: "record",
  access: "admin",
  audio: { assetId: "audio", url: "/audio" },
  audioUrl: "/audio",
  fields: [
    {
      field: {
        id: "choices",
        type: "string[]",
        visibility: "worker",
        provenance: "source_records",
      },
      value: ["Alpha", "Beta"],
    },
    {
      field: {
        id: "reference_answer",
        type: "json",
        visibility: "admin",
        provenance: "source_labels",
      },
      value: { value: "Alpha", privateNote: "must remain private" },
    },
    {
      field: {
        id: "metadata",
        type: "json",
        visibility: "admin",
        provenance: "source_records",
      },
      value: { secret: "do not project" },
    },
  ],
};
const { resolveBoundBatchBlocks } = load("lib/frontend/source-binding.ts");
assert.throws(
  () => resolveBoundBatchBlocks([training], [adminSample]),
  /unavailable or protected/,
);
const { resolveSourcePreviewBlocks } = load("lib/frontend/source-preview.ts");
assert.equal(
  resolveSourcePreviewBlocks([training], [adminSample])[0].sourceAnswerPreview,
  "Alpha",
);
assert.equal(
  adminSample.fields[1].field.visibility,
  "admin",
  "Cached source privacy is unchanged",
);
assert.equal(
  resolveSourcePreviewBlocks(
    [{ ...training, showSourceAnswer: false }],
    [adminSample],
  )[0].sourceAnswerPreview,
  undefined,
);
assert.throws(
  () =>
    resolveSourcePreviewBlocks(
      [training],
      [{ ...adminSample, access: "worker" }],
    ),
  /protected/,
);
assert.throws(
  () =>
    resolveSourcePreviewBlocks(
      [{ ...training, trainingAnswerPreview: false }],
      [adminSample],
    ),
  /training/,
);
const batchSamples = Array.from({ length: 4 }, (_, i) => ({
  ...adminSample,
  fields: [
    { ...adminSample.fields[0], value: ["Alpha " + i, "Beta " + i] },
    {
      ...adminSample.fields[1],
      value: { value: "Alpha " + i, privateNote: "never release" },
    },
  ],
}));
const batchPreview = resolveSourcePreviewBlocks(
  [{ ...training, numBatch: 4 }],
  batchSamples,
)[0];
assert.deepEqual(
  batchPreview.batchBlocks.map((b) => b.sourceAnswerPreview),
  ["Alpha 0", "Alpha 1", "Alpha 2", "Alpha 3"],
);
assert(!JSON.stringify(batchPreview).includes("privateNote"));
const canonicalTraining = {
  ...training,
  sourceBindings: {
    ...training.sourceBindings,
    options: {
      kind: "dataset",
      fieldId: "item.options",
      type: "choices",
      format: "array",
    },
  },
};
const canonicalSample = {
  ...adminSample,
  fields: [
    {
      field: {
        id: "item.options",
        type: "choices",
        visibility: "worker",
        provenance: "source_records",
      },
      value: [
        { id: "choice-1", label: "Train" },
        { id: "choice-2", label: "Horse" },
      ],
    },
    {
      ...adminSample.fields[1],
      value: { field: "options", value: "choice-1" },
    },
  ],
};
const canonicalPreview = resolveSourcePreviewBlocks(
  [canonicalTraining],
  [canonicalSample],
)[0];
assert.equal(canonicalPreview.sourceAnswerPreview, "choice-1");
console.log(
  "PASS reproduces full Builder protected-reference error; explicit admin training preview resolves legacy and canonical references in all four independent slots; worker projection stays closed",
);
const snapshot = {
  schemaVersion: 1,
  id: "t",
  definitionId: base.id,
  definitionVersion: 1,
  source: {
    kind: "dataset",
    projectId: "p",
    datasetId: "d",
    assetId: "asset",
    sourceRecordId: "source",
    recordId: "record",
    sourceUpdatedAt: "now",
  },
  choices: ["Alpha", "Beta"],
  trainingPreviews: [
    { blockId: choice.id, fieldId: "reference_answer", value: "Alpha" },
  ],
};
const resolved = resolveTaskInputs({ ...base, blocks: [training] }, snapshot);
assert.equal(resolved.definition.blocks[0].sourceAnswerPreview, "Alpha");
assert.equal(
  resolveTaskInputs({ ...base, blocks: [{ ...choice, numBatch: 1 }] }, snapshot)
    .definition.blocks[0].sourceAnswerPreview,
  undefined,
);
assert.throws(
  () =>
    resolveTaskInputs(
      { ...base, blocks: [training] },
      { ...snapshot, trainingPreviews: undefined },
    ),
  /protected/,
);
assert.throws(
  () =>
    resolveBoundBlocks([training], {
      fields: [
        {
          field: {
            id: "reference_answer",
            type: "json",
            visibility: "admin",
            provenance: "source_labels",
          },
          value: { value: "Alpha" },
        },
      ],
      audioUrl: "",
    }),
  /protected/,
);
const React = require("react"),
  { renderToStaticMarkup } = require("react-dom/server");
const { default: FinalResults, Distribution } = load(
  "components/admin/FinalResults.tsx",
);
const html = renderToStaticMarkup(
  React.createElement(FinalResults, {
    results: {
      complete: true,
      blocks: [],
      items: [item, ranking],
      policy: "Finals only",
    },
  }),
);
assert(
  html.includes("Per-question votes") &&
    html.includes("Original-answer matching") &&
    html.includes("Pooled class frequencies"),
);
assert(
  html.includes("Alpha") && html.includes("Rank 1") && html.includes("one.wav"),
);
const rankHtml = renderToStaticMarkup(
  React.createElement(Distribution, { item: ranking }),
);
assert(rankHtml.includes("Rank 2") && rankHtml.includes('value="2"'));
console.log(
  "PASS optional batched aid omission/partial/draft/invalid/required; independent tiers; per-question counts; reference mapping/unavailable/privacy; rank histograms; training opt-in/pinned inputs; SSR",
);

const { checkAnswers, default: BlockFields } = load(
  "components/workbench/BlockFields.tsx",
);
assert.deepEqual(
  checkAnswers(def.blocks, { choice: ["a", "b", "a", "b"] }),
  [],
);
assert.deepEqual(
  checkAnswers(def.blocks, {
    choice: ["a", "b", "a", "b"],
    aid: [null, { tiers: { words: [], phones: [], events: [] } }],
  }),
  [],
);
assert(checkAnswers(required.blocks, {}).length);
assert(
  checkAnswers(def.blocks, {
    choice: ["a", "b", "a", "b"],
    aid: [
      {
        tiers: {
          words: [{ id: "bad", start: 3, end: 1, text: "bad" }],
          phones: [],
          events: [],
        },
      },
    ],
  }).length,
);
const gridHtml = renderToStaticMarkup(
  React.createElement(BlockFields, {
    blocks: [multi.block],
    answers: { choice: ["a", "b"] },
    onChange() {},
  }),
);
const canonicalHtml = renderToStaticMarkup(
  React.createElement(BlockFields, {
    blocks: [canonicalPreview],
    answers: {},
    onChange() {},
  }),
);
assert(
  canonicalHtml.includes("<pre>Train</pre>"),
  "Canonical reference IDs render their resolved option label",
);
assert(!canonicalHtml.includes("<pre>choice-1</pre>"));
assert(gridHtml.includes("tb-choice-checkbox-grid"));
assert.equal((gridHtml.match(/type="checkbox"/g) || []).length, 2);
console.log(
  "PASS real workspace client validation: optional batched aids omitted/partial, invalid/required rejected; native checkbox-grid SSR",
);
