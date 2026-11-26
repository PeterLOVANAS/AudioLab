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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiolab-team-jobs-"));
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
      if (name === "cloudflare:workers")
        return { env: { DB: db, AUTH_MODE: "demo" } };
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

const {projectService,ProjectSlugTakenError}=load('lib/backend/services/projects.ts');
const {starterTaskDefinition}=load('lib/frontend/project-configuration.ts');
const {taskDraftSchema}=load('lib/backend/validation/task-definitions.ts');
const {taskDefinitionService}=load('lib/backend/services/task-definitions.ts');
(async()=>{
 const project=crypto.randomUUID();sqlite.prepare('INSERT INTO projects(id,name,slug) VALUES(?,?,?)').run(project,'Existing',project);
 for(const [id,role] of [['admin','admin'],['other','admin'],['worker','labeller'],['reject','admin']])sqlite.prepare('INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,?)').run(project,id,id,role);
 const actor={userId:'admin',displayName:'Admin',mode:'demo'};
 const created=await projectService.createForAdmin(db,{name:'New project',slug:'new-project'},actor);
 assert.equal(sqlite.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(created.id,actor.userId).role,'admin');
 await assert.rejects(projectService.createForAdmin(db,{name:'Duplicate',slug:'new-project'},{...actor,userId:'other'}),ProjectSlugTakenError);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id=?').get(created.id).n,1);
 await assert.rejects(projectService.createForAdmin(db,{name:'Forbidden',slug:'forbidden'},{...actor,userId:'worker'}),/permission/);
 sqlite.exec("CREATE TRIGGER reject_test_member BEFORE INSERT ON project_members WHEN NEW.user_id='reject' AND NEW.project_id<> '"+project+"' BEGIN SELECT RAISE(ABORT,'TEST_FAILURE'); END");
 await assert.rejects(projectService.createForAdmin(db,{name:'Rollback',slug:'rollback'},{...actor,userId:'reject'}),/TEST_FAILURE/);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug='rollback'").get().n,0);
 const draft=starterTaskDefinition('  Starter  ','Instructions','block-1');assert(taskDraftSchema.safeParse(draft).success);assert.equal(draft.name,'Starter');
 const def=await taskDefinitionService.create(db,created.id,draft);assert.equal(def.publishedVersion,0);assert.equal((await taskDefinitionService.get(db,def.id)).draft.instructions,'Instructions');
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');const Config=load('components/overview/ProjectConfiguration.tsx').default;
 const html=renderToStaticMarkup(React.createElement(Config,{projectId:created.id,projects:[created],onSaved(){}}));assert(html.includes('Create project'));assert(html.includes('Versioned research setup'));
 const rootPage=fs.readFileSync(path.join(root,'app/page.tsx'),'utf8');assert(!rootPage.includes('import LabellerProgress'));assert(rootPage.includes('progress={page === "progress"}'));assert(rootPage.includes('ProjectConfiguration'));
 assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
 console.log('PASS creator membership atomicity, duplicate slug/no role leak, labeller denial, rollback/no orphan, valid starter draft persistence, teammate setup SSR and current progress wiring.');
 console.log('Disposable DB:',filename);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>sqlite.close());
