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
const { intervalSetIoU, observation, analyzeItem } = load(
  "lib/backend/services/result-analytics.ts",
);
const block = {
  id: "events",
  type: "timeline_annotation",
  label: "Sound events",
  required: false,
  tiers: [
    {
      id: "sounds",
      name: "Sounds",
      kind: "interval",
      allowOverlap: true,
      labelMode: "text",
    },
  ],
};
const audio = [
  {
    id: "audio-one",
    url: "/api/v1/assets/audio-one/audio",
    label: "tone.wav",
    duration: 10,
  },
];
const rows = (arr) =>
  arr.map(([start, end, label = "tone"], i) => ({
    id: "event-" + i,
    start,
    end,
    text: label,
  }));
const value = (arr) => ({ tiers: { sounds: rows(arr) } });
const events = (arr) =>
  rows(arr).map(({ start, end, text }) => ({
    start,
    end,
    label: text,
    tierId: "sounds",
  }));
const approx = (a, b) => assert(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
for (const [a, b, expected] of [
  [[[1, 5]], [[1, 5]], 1],
  [[[1, 2]], [[3, 4]], 0],
  [[[1, 3]], [[3, 5]], 0],
  [[[1, 5]], [[3, 7]], 1 / 3],
  [[[1, 5]], [[2, 4]], 1 / 2],
  [
    [
      [1, 2],
      [4, 5],
    ],
    [
      [1, 2],
      [4, 5],
    ],
    1,
  ],
  [
    [
      [1, 4],
      [2, 5],
    ],
    [[1, 5]],
    1,
  ],
  [
    [
      [4, 5],
      [1, 3],
    ],
    [
      [1, 3],
      [4, 5],
    ],
    1,
  ],
  [
    [
      [1, 3],
      [3, 5],
    ],
    [[1, 5]],
    1,
  ],
  [[[1, 5, "bird"]], [[1, 5, "rain"]], 0],
  [[], [[1, 5]], 0],
])
  approx(intervalSetIoU(events(a), events(b)), expected);
assert.equal(intervalSetIoU([], []), null);
assert.throws(() => intervalSetIoU(events([[2, 2]]), []), /Invalid/);
assert.throws(() => intervalSetIoU(events([[NaN, 2]]), []), /Invalid/);
approx(
  intervalSetIoU(
    events(Array.from({ length: 30 }, (_, i) => [i, i + 0.5])),
    events(Array.from({ length: 30 }, (_, i) => [i, i + 0.5])),
  ),
  1,
);
const obs = (v, index = 0, submitted = true, b = block, a = audio) =>
  observation(
    b,
    v,
    {
      workerId: "worker-" + index,
      displayName: "Worker " + index,
      assignmentId: "assignment-" + index,
      revisionId: submitted ? "revision-" + index : null,
    },
    submitted,
    a,
  );
for (const v of [
  value([[1, 1]]),
  value([[-1, 2]]),
  value([[1, 11]]),
  value([["1", 5]]),
  { tiers: {} },
  value([[1, 2, ""]]),
])
  assert.equal(obs(v).state, "invalid");
assert.equal(obs(undefined).state, "missing");
assert.equal(obs(null).state, "missing");
assert.equal(obs(value([])).state, "empty");
assert.equal(obs(value([[1, 2]]), 0, false).state, "unsubmitted");
const item = (observations, b = block, a = audio) =>
  analyzeItem({
    key: "item",
    taskInstanceId: "task-v1",
    definitionId: "def",
    definitionVersion: 1,
    sourceKeys: ["item-one"],
    blockId: b.id,
    path: b.id,
    block: b,
    audio: a,
    observations,
  });
const single = item([obs(value([[1, 5]]))]);
assert.equal(single.mean, null);
assert.equal(single.eligiblePairs, 0);
const three = item([
  obs(value([[1, 5]]), 0),
  obs(value([[3, 7]]), 1),
  obs(value([[1, 5]]), 2),
]);
approx(three.mean, 5 / 9);
approx(three.min, 1 / 3);
assert.equal(three.max, 1);
assert.equal(three.eligiblePairs, 3);
const absence = item([
  obs(value([]), 0),
  obs(value([]), 1),
  obs(value([[1, 5]]), 2),
]);
assert.equal(absence.mean, 0);
assert.equal(absence.absencePairs, 1);
assert.equal(absence.excludedPairs, 1);
assert.equal(absence.eligiblePairs, 2);
const missing = item([
  obs(value([[1, 5]]), 0),
  obs(undefined, 1),
  obs(value([[1, 2]]), 2, false),
]);
assert.equal(missing.mean, null);
assert.equal(missing.excludedPairs, 3);
assert.equal(missing.excludedObservations, 2);
const raw = value([
    [4, 5],
    [1, 3],
    [2, 4],
  ]),
  before = JSON.stringify(raw);
item([obs(raw), obs(value([[1, 5]]), 1)]);
assert.equal(JSON.stringify(raw), before);
const categorical = {
  id: "category",
  label: "Category",
  type: "single_choice",
  required: true,
  options: [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ],
};
assert.equal(
  item(
    [obs("a", 0, true, categorical), obs("b", 1, true, categorical)],
    categorical,
  ).mean,
  0,
);
const multi = { ...categorical, type: "multiple_choice" };
approx(
  item([obs(["a"], 0, true, multi), obs(["a", "b"], 1, true, multi)], multi)
    .mean,
  1 / 2,
);
const numeric = {
  id: "number",
  label: "Score",
  type: "number",
  required: false,
};
assert.deepEqual(
  item([obs(2, 0, true, numeric), obs(4, 1, true, numeric)], numeric).numeric,
  { count: 2, mean: 3, min: 2, max: 4 },
);
const bool = {
  id: "boolean",
  label: "Audible",
  type: "boolean",
  required: false,
};
assert.equal(
  item([obs(true, 0, true, bool), obs(true, 1, true, bool)], bool).mean,
  1,
);
const rank = {
  id: "rank",
  label: "Order",
  type: "ranking",
  required: true,
  rankingMode: "labels",
  rankLabels: [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ],
};
assert.equal(
  item([obs(["a", "b"], 0, true, rank), obs(["b", "a"], 1, true, rank)], rank)
    .mean,
  0,
);
const transcript = {
  id: "transcript",
  label: "Words",
  type: "transcript",
  required: false,
};
assert.equal(
  item(
    [
      obs("Bird sings", 0, true, transcript),
      obs("bird sings", 1, true, transcript),
    ],
    transcript,
  ).mean,
  1,
);
const rating = {
  id: "rating",
  label: "Rating",
  type: "rating_scale",
  required: false,
  min: 1,
  max: 5,
  step: 1,
};
assert.equal(
  item([obs(2, 0, true, rating), obs(4, 1, true, rating)], rating).numeric.mean,
  3,
);
assert.equal(
  obs(value([]), 0, true, { ...block, required: true }).state,
  "invalid",
);
const candidate = {
  id: "candidate",
  label: "Candidate review",
  type: "candidate_vote",
  required: false,
};
assert.equal(obs("bad", 0, true, candidate).state, "invalid");
assert.equal(
  item(
    [
      obs({ value: "AGREE", candidateId: "curated" }, 0, true, candidate),
      obs({ value: "AGREE", candidateId: "curated" }, 1, true, candidate),
    ],
    candidate,
  ).mean,
  null,
);
const React = require("react"),
  { renderToStaticMarkup } = require("react-dom/server");
const { ResultInspector } = load("components/admin/FinalResults.tsx");
const html = renderToStaticMarkup(
  React.createElement(ResultInspector, { item: three, onClose() {} }),
);
assert(html.includes("Pairwise agreement matrix"));
assert(html.includes("33.3%"));
assert(html.includes("55.6%"));
assert(html.includes("Submitted intervals for Worker 0"));
assert(html.includes("tone.wav"));
assert(html.includes('src="/api/v1/assets/audio-one/audio"'));
assert(html.includes("Seek recording"));
const json = JSON.parse(JSON.stringify(three));
assert.equal(json.pairs.length, 3);
assert.equal(json.mean, three.mean);
console.log(
  "PASS exact interval-set values, >12 events, unsorted/overlap/empty/missing/invalid/draft, 1/2/3 workers, denominators, categorical/numeric, JSON and real inspector SSR",
);
