/** Fixture validation bridge using the actual task schema, never a parallel model. */
const fs = require("node:fs"),
  path = require("node:path"),
  ts = require("@typescript/typescript6");
const root = path.resolve(__dirname, ".."),
  cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "module", "exports", out)(
    (name) =>
      name.startsWith(".") || name.startsWith("@/")
        ? load(
            (name.startsWith("@/")
              ? name.slice(2)
              : path.relative(
                  root,
                  path.resolve(path.dirname(path.join(root, file)), name),
                )) + ".ts",
          )
        : require(name),
    mod,
    mod.exports,
  );
  return mod.exports;
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  load("lib/backend/validation/task-definitions.ts").taskDraftSchema.parse(
    JSON.parse(input),
  );
});
