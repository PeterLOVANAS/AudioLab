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

const React = require("react"),
  { renderToStaticMarkup } = require("react-dom/server");
const { Palette } = load("components/task-builder/BlockEditor.tsx");
let added;
const element = Palette({
  add: (kind) => {
    added = kind;
  },
});
const html = renderToStaticMarkup(element);
assert.equal(
  (html.match(/aria-label="Add Audio comparison"/g) || []).length,
  1,
);
assert(html.indexOf("Add Audio comparison") > html.indexOf("Answer fields"));
assert(
  html.indexOf("Add Audio comparison") <
    html.indexOf("Specialized / display fields"),
);
assert(!html.includes("Preview-only fields"));
assert(html.includes("Add Ranking"));
assert(!html.includes("Add Candidate vote"));
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value && typeof value === "object"
    ? [value, ...nodes(value.props?.children)]
    : [];
}
const button = nodes(element).find(
  (node) => node.props?.["aria-label"] === "Add Audio comparison",
);
assert(button);
button.props.onClick();
assert.equal(added, "audio_comparison");
console.log(
  "PASS Builder palette: Audio Comparison visible once in Answer fields, add callback correct, Ranking retained and Preview-only section removed. React SSR; no browser/DB.",
);
