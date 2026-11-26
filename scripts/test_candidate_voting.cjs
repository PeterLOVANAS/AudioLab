/** C05 combined: real services/handlers and SQL on a disposable on-disk SQLite DB.
 * No browser, build, precious state or remote D1. Run: node scripts/test_candidate_voting.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const ts = require('@typescript/typescript6');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audiolab-c05-'));
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
  const draft = taskDraftSchema.parse({ ...common,blocks });
  // Candidate Voting is deprecated for new protocols. Seed a historical draft
  // through the repository to exercise retained legacy runtime contracts.
  let saved;
  if (blocks.some(b=>b.type === 'candidate_vote')) {
    const id = crypto.randomUUID();
    await load('lib/backend/repositories/task-definitions.ts').taskDefinitionRepository.insert(db,id,projectId,draft);
    saved = await definitions.get(db,id);
  } else saved = await definitions.create(db,projectId,draft);
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
const { candidateResultService: results } = load('lib/backend/services/candidate-results.ts');
const { candidateResultRepository: resultRepo } = load('lib/backend/repositories/candidate-results.ts');
const { selectCandidate } = load('lib/frontend/candidate-voting.ts');
const { withCandidateSets } = load('lib/frontend/labeller-api.ts');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const Selection = load('components/workbench/CandidateSelection.tsx').default;
const inventoryRoute = load('app/api/v1/candidate-sets/sources/route.ts');
const resultRoute = load('app/api/v1/candidate-sets/[id]/result/route.ts');
const candidatesRoute = load('app/api/v1/assignments/[id]/candidates/route.ts');
const { readBlock, checkBlocks } = load('components/task-builder/model.ts');
(async () => {
  sqlite.prepare('INSERT INTO projects(id,name,slug) VALUES(?,?,?)').run(project,'C05',project);
  sqlite.prepare('INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)').run(dataset,project,'Synthetic','1');
  sqlite.prepare("INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key) VALUES(?,?,?,'r2',?)").run(asset,dataset,asset,asset);
  sqlite.prepare("INSERT INTO source_records(id,asset_id,source_record_id,source_domain) VALUES(?,?,?,'sound')").run(record,asset,'question');
  for (const [id,kind,value] of [[earlyId,'early_annotation',{value:'Bird',author:'PRIVATE_AUTHOR'}],[referenceId,'reference_answer',{value:'HIDDEN_TRUTH'}]])
    sqlite.prepare('INSERT INTO source_labels(id,source_record_id,kind,payload_json,provenance) VALUES(?,?,?,?,?)').run(id,record,kind,JSON.stringify(value),'imported');
  for (const actor of ['author-a','author-b','v1','v2','v3','v4','v5'])
    await assignments.addMember(db,{projectId:project,userId:actor,displayName:actor,role:'labeller'});
  await assignments.addMember(db,{projectId:project,userId:'admin',displayName:'Admin',role:'admin'});
  const sourceTask = await task(await protocol([textBlock]));
  const a = await submitSource(null,sourceTask,'author-a',{caption:'Song A'});
  const b = await submitSource(null,sourceTask,'author-b',{caption:'Song B'});
  const originals = sqlite.prepare('SELECT * FROM source_labels ORDER BY id').all();
  const refs = [{kind:'dataset_annotation',labelId:earlyId,field:'value'},
    {kind:'submission',revisionId:a.id,blockId:'caption'}, {kind:'submission',revisionId:b.id,blockId:'caption'}];
  const block = {...setBlock,minimumVotes:3,candidateOrigins:['dataset_annotation','submission']};
  const draft = {...common,blocks:[block]};
  assert(taskDraftSchema.safeParse(draft).success);
  for (const bad of [{minimumVotes:0},{minimumVotes:1.5},{candidateOrigins:[]},{candidateOrigins:['submission','submission']}])
    assert(!taskDraftSchema.safeParse({...draft,blocks:[{...block,...bad}]}).success);
  assert(!taskDraftSchema.safeParse({...draft,blocks:[block,{...block,id:'second'}]}).success);
  const loadedBlock = readBlock(block);
  assert.equal(loadedBlock.candidateSource,'set');
  assert.equal(loadedBlock.minimumVotes,3);
  assert.equal(checkBlocks([loadedBlock]).length,0);
  async function ballot(minimum=3) {
    const definition = await protocol([{...block,minimumVotes:minimum}]);
    const t = await task(definition);
    const created = await sets.create(db,{projectId:project,taskInstanceId:t.id,blockId:'vote',userId:'admin',requestId:crypto.randomUUID(),sources:refs});
    return {t,set:created.candidateSet,entries:await repo.entries(db,t.id)};
  }
  const majority = await ballot();
  const invRequest = new Request(`http://local/api/v1/candidate-sets/sources?${new URLSearchParams({projectId:project,userId:'admin',taskInstanceId:majority.t.id,blockId:'vote'})}`);
  const inventory = await (await inventoryRoute.GET(invRequest)).json();
  assert.equal(inventory.sources.length,3);
  assert(!JSON.stringify(inventory).includes('HIDDEN_TRUTH'));
  assert(!JSON.stringify(inventory).includes('PRIVATE_AUTHOR'));
  await assert.rejects(sets.inventory(db,project,'v1',majority.t.id,'vote'),expects(403));
  const restricted = await task(await protocol([{...block,candidateOrigins:['submission']}]));
  await assert.rejects(sets.create(db,{projectId:project,userId:'admin',taskInstanceId:restricted.id,blockId:'vote',requestId:'restricted',sources:refs}),expects(422));
  console.log('PASS Builder serialization/publication, source categories, min-vote policy, eligible source inventory and permissions');

  let calls = 0;
  global.fetch = async (url, init) => {
    calls++;
    const req = new Request(new URL(url,'http://local'),init);
    const id = new URL(req.url).pathname.split('/')[4];
    return candidatesRoute.GET(req,{params:Promise.resolve({id})});
  };
  const firstJob = await job(majority.t,'v1');
  const detail = {assignment:firstJob,taskInstance:await tasks.get(db,majority.t.id)};
  const resolved = await withCandidateSets(detail,'v1');
  assert.equal(calls,1);
  assert.equal(resolved.taskInstance.candidateSets.vote.candidates.length,3);
  const staticDetail = {assignment:firstJob,taskInstance:{...detail.taskInstance,definition:{...detail.taskInstance.definition,blocks:[textBlock]}}};
  assert.equal(await withCandidateSets(staticDetail,'v1'),staticDetail);
  assert.equal(calls,1);
  const view = resolved.taskInstance.candidateSets.vote;
  let sideEffects = 0;
  const answer = selectCandidate(view,view.candidates[0].id);
  const render = (set,value) => renderToStaticMarkup(React.createElement(Selection,{set,value,onChange:()=>sideEffects++}));
  assert(render(view,answer).includes('checked=""'));
  assert(!render(view,{...answer,candidateSetSnapshotId:'stale'}).includes('checked=""'));
  assert(render(undefined,{}).includes('not ready'));
  assert(render({...view,candidates:[]},{}).includes('No eligible'));
  assert.equal(sideEffects,0);
  assert.throws(()=>selectCandidate(view,'unknown'));
  await annotations.save(db,firstJob.id,{labellerId:'v1',expectedRevision:0,answers:{vote:answer}},'draft');
  const reopened = (await annotations.current(db,firstJob.id,'v1')).current;
  assert.deepEqual(reopened.answers.vote,answer);
  assert(render(view,reopened.answers.vote).includes('checked=""'));
  assert.equal((await results.resolve(db,project,'admin',majority.set.id,false)).totalVotes,0);
  const submitted = await annotations.save(db,firstJob.id,{labellerId:'v1',expectedRevision:1,answers:{vote:answer}},'submitted');
  const pending = await results.resolve(db,project,'admin',majority.set.id,true);
  assert.equal(pending.status,'pending_votes');
  assert.equal(pending.persisted,true);
  const vote = async (ballot,actor,index) => {
    const assignment = await job(ballot.t,actor);
    const view = (await sets.forAssignment(db,assignment.id,actor)).candidateSets.vote;
    const answer = selectCandidate(view,ballot.entries[index].id);
    return {assignment,revision:await annotations.save(db,assignment.id,{labellerId:actor,expectedRevision:0,answers:{vote:answer}},'submitted')};
  };
  const second = await vote(majority,'v2',1);
  const third = await vote(majority,'v3',0);
  const preview = await results.resolve(db,project,'admin',majority.set.id,false);
  assert.equal(preview.status,'accepted'); assert.equal(preview.persisted,false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM candidate_vote_results WHERE status='accepted'").get().n,0);
  const resultRequest = () => new Request(`http://local/result`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:project,userId:'admin'})});
  const response = await resultRoute.POST(resultRequest(),{params:Promise.resolve({id:majority.set.id})});
  assert.equal(response.status,200);
  const accepted = (await response.json()).result;
  assert.equal(accepted.status,'accepted'); assert.equal(accepted.persisted,true);
  assert.equal(accepted.counts[majority.entries[0].id],2);
  assert.equal(accepted.accepted.value,'Bird');
  assert.equal(accepted.accepted.source.labelId,earlyId);
  assert.deepEqual(accepted.votes.map(v=>v.annotationRevisionId),[submitted.id,second.revision.id,third.revision.id]);
  assert.equal((await results.resolve(db,project,'admin',majority.set.id,true)).id,accepted.id);
  await assert.rejects(results.resolve(db,project,'v1',majority.set.id,true),expects(403));
  await assert.rejects(results.resolve(db,crypto.randomUUID(),'admin',majority.set.id,true),expects(403));
  const closedView = (await withCandidateSets(detail,'v1')).taskInstance.candidateSets.vote;
  assert.equal(closedView.closed,true);
  for (const privateField of ['PRIVATE_AUTHOR','HIDDEN_TRUTH','actorId','counts','accepted',a.id,b.id])
    assert(!JSON.stringify(closedView).includes(privateField));
  assert(render(closedView,answer).includes('disabled=""'));
  assert.throws(()=>selectCandidate(closedView,answer.selectedCandidateId));
  const late = await job(majority.t,'v4');
  await assert.rejects(annotations.save(db,late.id,{labellerId:'v4',expectedRevision:0,answers:{vote:answer}},'submitted'),AnnotationConflictError);
  for (const sql of ['UPDATE candidate_vote_results SET status=status','DELETE FROM candidate_vote_results'])
    assert.throws(()=>sqlite.exec(sql),/CANDIDATE_RESULT_IMMUTABLE/);
  console.log('PASS owner-scoped runtime fetch/render, selection draft/submit/reopen, majority/minimum, terminal provenance and SQL closure');

  const tie = await ballot(2);
  await vote(tie,'v1',0); await vote(tie,'v2',1);
  const tied = await results.resolve(db,project,'admin',tie.set.id,true);
  assert.equal(tied.status,'pending_adjudication'); assert.equal(tied.accepted,undefined);
  const more = await vote(tie,'v3',1);
  const resolvedTie = await results.resolve(db,project,'admin',tie.set.id,true);
  assert.equal(resolvedTie.status,'accepted'); assert.equal(resolvedTie.accepted.source.revisionId,a.id);
  assert(resolvedTie.votes.some(v=>v.annotationRevisionId===more.revision.id));
  const plurality = await ballot(4);
  await vote(plurality,'v1',0);await vote(plurality,'v2',0);await vote(plurality,'v3',1);await vote(plurality,'v4',2);
  assert.equal((await results.resolve(db,project,'admin',plurality.set.id,true)).status,'pending_adjudication');
  const stale = await results.resolve(db,project,'admin',plurality.set.id,false);
  const oldWatermark = Math.max(...(await resultRepo.votes(db,plurality.t.id,'vote')).map(r=>r.sequence));
  await vote(plurality,'v5',0);
  assert.equal(await resultRepo.insert(db,{...stale,id:crypto.randomUUID()},oldWatermark),false);
  assert.deepEqual(sqlite.prepare('SELECT * FROM source_labels ORDER BY id').all(),originals);
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
  sqlite.close(); sqlite = new DatabaseSync(filename); sqlite.exec('PRAGMA foreign_keys=ON');
  assert.deepEqual(await results.resolve(db,project,'admin',majority.set.id,false),accepted);
  assert.deepEqual((await annotations.current(db,firstJob.id,'v1')).current.answers.vote,answer);
  console.log('PASS 1–1 tie, plurality exclusion, subsequent resolution, stale watermark rejection, immutable source data and reopened persisted results');
  console.log(`PASS C05 combined pipeline (on-disk SQLite/D1 adapter): ${filename}`);
})().catch(error => {console.error(error);process.exitCode=1;}).finally(()=>sqlite.close());
