/** Focused export projections and ZIP interoperability; no browser or preserved DB. */
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  ts = require("@typescript/typescript6"),
  assert = require("node:assert/strict"),
  { execFileSync } = require("node:child_process");
const root = process.cwd(),
  cache = new Map();
function load(file) {
  file = path.resolve(root, file);
  if (cache.has(file)) return cache.get(file).exports;
  const m = { exports: {} };
  cache.set(file, m);
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
        ? path.join(root, name.slice(2))
        : path.resolve(path.dirname(file), name);
      const target = [
        base,
        base + ".ts",
        base + ".tsx",
        path.join(base, "index.ts"),
      ].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!target) throw Error(name);
      return load(target);
    },
    m,
    m.exports,
  );
  return m.exports;
}
(async () => {
  const { choiceDistribution } = load(
    "lib/backend/services/research-export.ts",
  );
  const block = {
    id: "choice",
    type: "multiple_choice",
    label: "Seven choices",
    required: true,
    options: Array.from({ length: 7 }, (_, i) => ({
      id: "id-" + i,
      label: "Option " + i,
    })),
  };
  const distribution = choiceDistribution(block, [
    ["id-0", "id-6"],
    ["id-6"],
    ["id-3", "id-3"],
  ]);
  assert.equal(distribution.counts.length, 7);
  assert.equal(distribution.counts[6].count, 2);
  assert.equal(distribution.counts[3].count, 1);
  assert.equal(distribution.counts[2].count, 0);
  assert.equal(distribution.submitted, 3);
  assert.deepEqual(
    choiceDistribution({ ...block, type: "boolean" }, [
      false,
      true,
      false,
    ]).counts.map((c) => c.count),
    [1, 2],
  );
  const custom = choiceDistribution({ ...block, type: "single_choice" }, [
    { selection: "__custom__", customText: "Bird" },
  ]);
  assert.equal(custom.counts.at(-1).label, "Bird");
  assert.equal(custom.counts.at(-1).count, 1);
  const React = require("react"),
    { renderToStaticMarkup } = require("react-dom/server"),
    { ExportChoiceChart } = load(
      "components/admin/ResearchExportWorkspace.tsx",
    );
  const html = renderToStaticMarkup(
    React.createElement(ExportChoiceChart, {
      label: "Seven-choice Voting distribution",
      value: distribution,
    }),
  );
  assert.equal((html.match(/export-vote-row/g) || []).length, 7);
  assert(!html.includes("<input"));
  assert(html.includes("Option 6"));
  const { ExportRankingPreview } = load(
    "components/admin/ResearchExportWorkspace.tsx",
  );
  const ranking = renderToStaticMarkup(
    React.createElement(ExportRankingPreview, {
      block: {
        id: "rank",
        type: "ranking",
        label: "Order",
        rankingMode: "labels",
        rankLabels: [
          { id: "a", label: "Alpha" },
          { id: "z", label: "Zebra" },
        ],
      },
      value: ["z", "a"],
      task: { task: { audioAssets: [] } },
    }),
  );
  assert(ranking.indexOf("Zebra") < ranking.indexOf("Alpha"));
  assert(!ranking.includes("<button"));
  const { zipStream, zipBytes } = load("lib/backend/export/zip.ts");
  const encoder = new TextEncoder();
  const bytes = new Uint8Array(
    await new Response(
      zipStream([
        zipBytes(
          "annotations/audio-id.json",
          encoder.encode('{"audioId":"audio-id"}'),
        ),
        zipBytes(
          "audio/audio-id.wav",
          new Uint8Array([82, 73, 70, 70, 0, 1, 2]),
        ),
        zipBytes("metadata/ภาษาไทย.txt", encoder.encode("คำอธิบาย")),
      ]),
    ).arrayBuffer(),
  );
  const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "audiolab-export-zip-"),
    ),
    file = path.join(directory, "archive.zip");
  fs.writeFileSync(file, bytes);
  execFileSync("python3", [
    "-c",
    "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read('audio/audio-id.wav')[:4]==b'RIFF'; assert z.read('metadata/ภาษาไทย.txt').decode()=='คำอธิบาย'; assert len(z.namelist())==3",
    file,
  ]);
  assert.throws(
    () => zipStream([zipBytes("../escape", new Uint8Array())]),
    /ZIP path/,
  );
  assert.throws(
    () =>
      zipStream([
        zipBytes("a", new Uint8Array()),
        zipBytes("a", new Uint8Array()),
      ]),
    /ZIP path/,
  );
  await assert.rejects(
    new Response(
      zipStream([
        {
          name: "bad",
          size: 3,
          async open() {
            return new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array([1]));
                c.close();
              },
            });
          },
        },
      ]),
    ).arrayBuffer(),
    /truncated/,
  );
  console.log(
    "PASS arbitrary choice counts/zeros, multi-choice per-worker deduplication, Boolean/custom answers, server-rendered non-interactive bars, ZIP CRC/Unicode/audio matching and unsafe/truncated archive rejection.",
  );
  console.log("Disposable ZIP:", file);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
