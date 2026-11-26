/** Server-rendered control contract only; no browser/audio decoding involved. */
const fs = require("node:fs"),
  path = require("node:path"),
  ts = require("@typescript/typescript6"),
  assert = require("node:assert/strict");
const root = process.cwd(),
  cache = new Map();
const runtimeStubs = new Map();
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
      if (runtimeStubs.has(name)) return runtimeStubs.get(name);
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
const Sidebar = load("components/layout/Sidebar.tsx").default;
const markup = (role) =>
  renderToStaticMarkup(
    React.createElement(Sidebar, {
      member: { userId: "test", projectId: "p", displayName: "Test", role },
      activePage: "overview",
      onNavigate() {},
      mobileOpen: false,
      onClose() {},
    }),
  );
const admin = markup("admin"),
  worker = markup("labeller");
for (const label of [
  "Research Overview",
  "Team &amp; assignments",
  "Labeller progress",
  "Research exports",
  "Project configuration",
  "Task Builder",
])
  assert.ok(admin.includes(label), label);
for (const label of [
  "Review &amp; adjudication",
  "Assets &amp; import",
  "Workspace guide",
  "Negation QC",
  "Sound Grounding",
  "Audio Captioning",
  "Transcription &amp; alignment",
])
  assert.equal(admin.includes(label), false, label);
assert.ok(worker.includes("Workspace"));
assert.equal(worker.includes("Research Overview"), false);
for (const html of [admin, worker]) {
  assert.ok(html.includes("<strong>Test</strong>"));
  assert.equal(html.includes("Demo researcher"), false);
  assert.equal(html.includes("Local preview"), false);
}
assert.ok(admin.includes("<small>admin</small>"));
assert.ok(worker.includes("<small>labeller</small>"));
const noMembership = renderToStaticMarkup(
  React.createElement(Sidebar, {
    member: {
      userId: "test",
      projectId: "p",
      displayName: "Test",
      role: "admin",
    },
    identityRole: null,
    activePage: "overview",
    onNavigate() {},
    mobileOpen: false,
    onClose() {},
  }),
);
assert.ok(noMembership.includes("<small>No active project role</small>"));
assert.equal(noMembership.includes("<small>admin</small>"), false);
const Overview = load("components/overview/ResearchOverview.tsx").default;
assert.ok(
  renderToStaticMarkup(
    React.createElement(Overview, { projectId: "", onOpen() {} }),
  ).includes("Choose an authorized project"),
);
console.log(
  "PASS SSR: only implemented navigation pages, labeller role isolation and Overview empty context. No browser/visual testing.",
);

// Unit-test response display mapping only. Real credential/authorization and UI
// behavior are exercised separately by the Worker HTTP and browser acceptance.
async function checkSessionDisplay() {
  let displayName = "Account Display Name";
  let fallbackReads = 0;
  runtimeStubs.set("cloudflare:workers", {
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(userId) {
              assert.equal(userId, "account-id");
              return {
                async first() {
                  assert.equal(
                    sql,
                    "SELECT username FROM auth_accounts WHERE user_id=?",
                  );
                  fallbackReads++;
                  return { username: "account-username" };
                },
                async all() {
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    },
  });
  runtimeStubs.set("@/lib/backend/auth/identity", {
    authenticate: async () => ({
      userId: "account-id",
      displayName,
      mode: "demo",
    }),
    AuthError: class extends Error {},
  });
  const route = load("app/api/v1/auth/session/route.ts");
  const named = await (
    await route.GET(new Request("http://127.0.0.1/"))
  ).json();
  assert.equal(named.user.displayName, displayName);
  assert.equal(fallbackReads, 0);
  displayName = "   ";
  const fallback = await (
    await route.GET(new Request("http://127.0.0.1/"))
  ).json();
  assert.equal(fallback.user.displayName, "account-username");
  assert.equal(fallbackReads, 1);
  assert.deepEqual(Object.keys(fallback.user).sort(), [
    "displayName",
    "mode",
    "userId",
  ]);
  console.log(
    "PASS session display mapping: account name preferred, blank name falls back to username without extra identity fields.",
  );
}
checkSessionDisplay().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
