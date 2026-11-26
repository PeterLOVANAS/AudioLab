/** Manual repeated groups: real services/handlers and SQL on a disposable on-disk SQLite DB.
 * No browser, build, precious state or remote D1. Run: node scripts/test_repeated_groups.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const ts = require('@typescript/typescript6');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audiolab-groups-'));
const filename = path.join(directory, 'candidate-votes.sqlite');
let sqlite = new DatabaseSync(filename);
sqlite.exec('PRAGMA foreign_keys=ON');
for (const file of fs.readdirSync(path.join(root,'migrations')).filter(file => file.endsWith('.sql')).sort())
  sqlite.exec(fs.readFileSync(path.join(root,'migrations',file),'utf8'));
const statement = (sql, args = []) => ({ sql, args,
  bind(...values) { return statement(sql,values); },
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
  async run() { return { meta: sqlite.prepare(sql).run(...args) }; },
});
let tail = Promise.resolve();
const db = { prepare: statement, batch(statements) {
  // Serialize real transactions, matching D1's single-writer behavior. SQL
  // constraints/triggers (not this adapter) decide conflicts and rollbacks.
  const operation = tail.then(() => {
    sqlite.exec('BEGIN');
    try {
      const result = statements.map(s => ({ meta: sqlite.prepare(s.sql).run(...s.args) }));
      sqlite.exec('COMMIT'); return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  });
  tail = operation.catch(() => {}); return operation;
} };
const cache = new Map();
function load(relative, dev = true) {
  const key = `${dev}:${relative}`;
  if (cache.has(key)) return cache.get(key).exports;
  const file = path.join(root,relative);
  const output = ts.transpileModule(fs.readFileSync(file,'utf8'), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText.replaceAll('import.meta.env.DEV',String(dev));
  const mod = { exports: {} }; cache.set(key,mod);
  new Function('require','module','exports',output)(name => {
    if (name.endsWith('.css')) return {}; // Node SSR has no stylesheet loader.
    if (name === 'cloudflare:workers') return { env: { DB: db } };
    if (name.startsWith('@/') || name.startsWith('.')) {
      const resolved = name.startsWith('@/') ? name.slice(2) : path.relative(root,path.resolve(path.dirname(file),name));
      return load(resolved + (fs.existsSync(path.join(root,resolved + '.ts')) ? '.ts' : '.tsx'),dev);
    }
    return require(name);
  },mod,mod.exports);
  return mod.exports;
}
const { taskDefinitionService: definitions } = load('lib/backend/services/task-definitions.ts');
const { taskInstanceService: tasks } = load('lib/backend/services/task-instances.ts');
const { assignmentService: assignments } = load('lib/backend/services/assignments.ts');
const { annotationService: annotations, AnnotationAnswerError, AnnotationConflictError } = load('lib/backend/services/annotations.ts');
const { candidateSetService: sets, CandidateSetError } = load('lib/backend/services/candidate-sets.ts');
const { candidateSetRepository: repo } = load('lib/backend/repositories/candidate-sets.ts');
const { taskDraftSchema } = load('lib/backend/validation/task-definitions.ts');
const { createCandidateSetSchema } = load('lib/backend/validation/candidate-sets.ts');
const project = crypto.randomUUID(), dataset = crypto.randomUUID(), asset = crypto.randomUUID(), asset2 = crypto.randomUUID();
const foreignProject = crypto.randomUUID(), foreignDataset = crypto.randomUUID(), foreignAsset = crypto.randomUUID();
const record = asset + '::question', secondRecord = asset + '::second', otherRecord = asset2 + '::question';
const earlyId = record + '::early_annotation', referenceId = record + '::reference_answer';
const common = { name: 'C04', description: '', domain: 'sound', instructions: 'Compare candidates',
  policy: { requiredIndependentVotes: 1, blindToOthers: true, requiresReview: false } };
const textBlock = { id: 'caption', type: 'text', label: 'Caption', required: true };
const setBlock = { id: 'vote', type: 'candidate_vote', label: 'Select best', required: true, candidateSource: 'set' };
async function protocol(blocks, projectId = project) {
  const saved = await definitions.create(db,projectId,taskDraftSchema.parse({ ...common,blocks }));
  await definitions.publish(db,saved.id,1,0); return saved.id;
}
async function task(definitionId, assetId = asset, sourceRecordId = 'question', projectId = project) {
  return tasks.create(db,{ projectId,definitionId,definitionVersion: 1,assetId,
    ...(sourceRecordId === null ? {} : { sourceRecordId }) });
}
async function job(task, actor = 'voter') {
  return assignments.create(db,{ projectId: task.projectId,taskInstanceId: task.id,labellerId: actor });
}
async function submitSource(definitionId, sourceTask, actor, answers, status = 'submitted') {
  const assignment = await job(sourceTask,actor);
  return annotations.save(db,assignment.id,{ labellerId: actor,expectedRevision: 0,answers },status);
}
const expects = (status) => error => error instanceof CandidateSetError && error.status === status;

const {validateAnswers}=load('lib/backend/validation/annotation-answers.ts');
(async()=>{
 sqlite.prepare('INSERT INTO projects(id,name,slug) VALUES(?,?,?)').run(project,'Groups',project);
 const group={id:'g',type:'repeated_group',label:'Events',required:true,minItems:1,maxItems:2,itemLabel:'Event',blocks:[textBlock]};
 const nested={...group,blocks:[{...group,id:'inner'}]};
 assert(taskDraftSchema.safeParse({...common,blocks:[nested]}).success);
 const definition=await protocol([nested]);
 assert((await definitions.get(db,definition)).publishedVersion===1);
 const check=(value,final=true)=>validateAnswers({...common,id:definition,version:1,blocks:[group]},{g:value},final);
 assert.equal(check([],false).length,0);assert(check([]).length);
 assert.equal(check([{id:'a',answers:{caption:'One'}},{id:'b',answers:{caption:'Two'}}]).length,0);
 assert(check([{id:'a',answers:{caption:'One'}},{id:'a',answers:{caption:'Two'}}]).length);
 assert(check([{id:'a',answers:{caption:'One'}},{id:'b',answers:{caption:'Two'}},{id:'c',answers:{caption:'Three'}}]).length);
 assert(check([{id:'a',answers:{unknown:'Wrong'}}]).length);
 assert(check([{id:'a',answers:{caption:42}}]).length);
 assert(!taskDraftSchema.safeParse({...common,blocks:[{...group,minItems:3,maxItems:2}]}).success);
 assert(!taskDraftSchema.safeParse({...common,blocks:[{...group,blocks:[{...textBlock,sourceBindings:{label:{kind:'dataset',fieldId:'question',type:'string'}}}]}]}).success);
 console.log('PASS repeated-group publication, nested schema, draft/final limits, stable IDs and child validation');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>sqlite.close());
