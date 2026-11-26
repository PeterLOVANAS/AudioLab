const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("@typescript/typescript6");
const root = path.resolve(__dirname, "..");
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative).exports;
  const file = path.join(root, relative + ".ts");
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file,
  }).outputText;
  const module = { exports: {} }; cache.set(relative, module);
  new Function("require", "module", "exports", output)((name) =>
    name.startsWith("@/") ? load(name.slice(2)) : require(name), module, module.exports);
  return module.exports;
}
const { resolveBoundBlocks } = load("lib/frontend/source-binding");
const { taskDraftSchema } = load("lib/backend/validation/task-definitions");
const staticBlock = { id: "b1", type: "single_choice", label: "Static prompt", required: true,
  options: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] };
const bound = { ...staticBlock, sourceBindings: {
  label: { kind: "dataset", fieldId: "question", type: "string" },
  options: { kind: "dataset", fieldId: "choices", type: "string[]" },
} };
const sample = { fields: [
  { field: { id: "question", visibility: "worker", type: "string" }, value: "What sound?" },
  { field: { id: "choices", visibility: "worker", type: "string[]" }, value: ["A", "B", "C", "D"] },
  { field: { id: "reference_answer", visibility: "admin", type: "json" }, value: { value: "SECRET" } },
] };
const draft = { name: "Test", description: "", domain: "sound", instructions: "Listen",
  blocks: [bound], policy: { requiredIndependentVotes: 1, blindToOthers: true, requiresReview: false } };
assert.equal(taskDraftSchema.safeParse(draft).success, true);
assert.deepEqual(JSON.parse(JSON.stringify(draft)).blocks[0].sourceBindings, bound.sourceBindings);
const rendered = resolveBoundBlocks([bound], sample)[0];
assert.equal(rendered.label, "What sound?");
assert.deepEqual(rendered.options.map((o) => o.label), ["A", "B", "C", "D"]);
assert.equal(JSON.stringify(rendered).includes("SECRET"), false);
assert.deepEqual(resolveBoundBlocks([staticBlock], null), [staticBlock]);
assert.equal(taskDraftSchema.safeParse({ ...draft, blocks: [staticBlock] }).success, true);
assert.throws(() => resolveBoundBlocks([bound], null), /Select an available/);
assert.throws(() => resolveBoundBlocks([bound], { fields: sample.fields.slice(0, 1) }), /unavailable/);
const invalid = { ...bound, sourceBindings: { ...bound.sourceBindings,
  options: { kind: "dataset", fieldId: "question", type: "string" } } };
assert.equal(taskDraftSchema.safeParse({ ...draft, blocks: [invalid] }).success, false);
console.log("PASS bound question and four choices; answer hidden");
console.log("PASS static definition and bound JSON round-trip");
console.log("PASS incompatible and unavailable source rejected");
