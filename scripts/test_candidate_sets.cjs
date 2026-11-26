/** C04 only: real services/handlers and SQL on a disposable on-disk SQLite DB.
 * No browser, build, precious state or remote D1. Run: node scripts/test_candidate_sets.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const ts = require('@typescript/typescript6');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audiolab-c04-'));
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
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText.replaceAll('import.meta.env.DEV',String(dev));
  const mod = { exports: {} }; cache.set(key,mod);
  new Function('require','module','exports',output)(name => {
    if (name === 'cloudflare:workers') return { env: { DB: db } };
    if (name.startsWith('@/') || name.startsWith('.')) {
      const resolved = name.startsWith('@/') ? name.slice(2) : path.relative(root,path.resolve(path.dirname(file),name));
      return load(resolved + '.ts',dev);
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
(async () => {
  for (const [p,d] of [[project,dataset],[foreignProject,foreignDataset]]) {
    sqlite.prepare('INSERT INTO projects(id,name,slug) VALUES(?,?,?)').run(p,'C04',p);
    sqlite.prepare('INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)').run(d,p,'Synthetic','1');
  }
  for (const [a,d] of [[asset,dataset],[asset2,dataset],[foreignAsset,foreignDataset]])
    sqlite.prepare("INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key) VALUES(?,?,?,'r2',?)").run(a,d,a,a);
  for (const [id,a,r] of [[record,asset,'question'],[secondRecord,asset,'second'],[otherRecord,asset2,'question'],[foreignAsset + '::question',foreignAsset,'question']])
    sqlite.prepare("INSERT INTO source_records(id,asset_id,source_record_id,source_domain) VALUES(?,?,?,'sound')").run(id,a,r);
  sqlite.prepare("INSERT INTO source_labels(id,source_record_id,kind,payload_json,provenance) VALUES(?,?,'early_annotation',?,'imported_early_annotation')")
    .run(earlyId,record,JSON.stringify({ value: 'Bird', author: 'PRIVATE_AUTHOR', nested: { answer: 'HIDDEN_GROUND_TRUTH' } }));
  sqlite.prepare("INSERT INTO source_labels(id,source_record_id,kind,payload_json,provenance) VALUES(?,?,'reference_answer',?,'imported_source_answer')")
    .run(referenceId,record,'{"value":"REFERENCE_SECRET"}');
  for (const userId of ['author-a','author-b','voter','voter-2','draft-author'])
    await assignments.addMember(db,{ projectId: project,userId,displayName: userId,role: 'labeller' });
  await assignments.addMember(db,{ projectId: project,userId: 'admin',displayName: 'Admin',role: 'admin' });
  await assignments.addMember(db,{ projectId: foreignProject,userId: 'foreign',displayName: 'Foreign',role: 'labeller' });

  const sourceDefinition = await protocol([textBlock]);
  const sourceTask = await task(sourceDefinition);
  const revisionA = await submitSource(sourceDefinition,sourceTask,'author-a',{ caption: 'A bird sings' });
  const revisionB = await submitSource(sourceDefinition,sourceTask,'author-b',{ caption: 'Wind in trees' });
  const draftRevision = await submitSource(sourceDefinition,sourceTask,'draft-author',{ caption: 'Unfinished' },'draft');
  const otherTask = await task(sourceDefinition,asset2);
  const otherRevision = await submitSource(sourceDefinition,otherTask,'author-a',{ caption: 'Wrong audio' });
  const wrongRecordTask = await task(sourceDefinition,asset,'second');
  const wrongRecordRevision = await submitSource(sourceDefinition,wrongRecordTask,'author-a',{ caption: 'Wrong question' });
  const foreignDefinition = await protocol([textBlock],foreignProject);
  const foreignTask = await task(foreignDefinition,foreignAsset,'question',foreignProject);
  const foreignRevision = await submitSource(foreignDefinition,foreignTask,'foreign',{ caption: 'Foreign project' });
  const sourceHistory = sqlite.prepare('SELECT * FROM annotation_revisions ORDER BY id').all();
  const labelsBefore = sqlite.prepare('SELECT * FROM source_labels ORDER BY id').all();
  const definition = await protocol([setBlock]);
  const voting = await task(definition);
  const voteJob = await job(voting);
  const ownJob = await job(voting,'author-a');
  const refs = [ { kind: 'dataset_annotation',labelId: earlyId },
    { kind: 'submission',revisionId: revisionA.id,blockId: 'caption' },
    { kind: 'submission',revisionId: revisionB.id,blockId: 'caption' } ];
  const input = { projectId: project,taskInstanceId: voting.id,blockId: 'vote',userId: 'admin',requestId: 'create-once',sources: refs };
  assert(createCandidateSetSchema.safeParse(input).success);
  assert(!createCandidateSetSchema.safeParse({ ...input,sources: [{ kind: 'dataset_annotation',labelId: earlyId,field: 'author' },refs[1]] }).success);
  assert(!taskDraftSchema.safeParse({ ...common,blocks: [{ ...setBlock,allowSelfVote: 'yes' }] }).success);
  const concurrent = await Promise.all([sets.create(db,input),sets.create(db,input)]);
  assert.equal(concurrent.filter(result => result.created).length,1);
  const snapshot = concurrent[0].candidateSet;
  assert.equal(concurrent[1].candidateSet.id,snapshot.id);
  assert.equal((await repo.entries(db,voting.id)).length,3);
  assert.equal((await sets.create(db,input)).created,false);
  await assert.rejects(sets.create(db,{ ...input,requestId: 'replace' }),expects(409));
  await assert.rejects(sets.create(db,{ ...input,sources: [...refs].reverse() }),expects(409));
  await assert.rejects(sets.create(db,{ ...input,userId: 'voter' }),expects(403));
  await assert.rejects(sets.create(db,{ ...input,sources: [refs[0],refs[0]] }),expects(422));
  console.log('PASS immutable set creation, concurrent/retried request idempotency, conflict and duplicate-source guards');

  async function rejectedSource(source, expected = 422, target = null) {
    const fresh = target ?? await task(await protocol([setBlock]));
    await assert.rejects(sets.create(db,{ ...input,taskInstanceId: fresh.id,requestId: crypto.randomUUID(),sources: [refs[0],source] }),expects(expected));
    assert.equal((await repo.sets(db,fresh.id)).length,0);
  }
  await rejectedSource({ kind: 'dataset_annotation',labelId: referenceId });
  await rejectedSource({ kind: 'submission',revisionId: draftRevision.id,blockId: 'caption' });
  await rejectedSource({ kind: 'submission',revisionId: otherRevision.id,blockId: 'caption' });
  await rejectedSource({ kind: 'submission',revisionId: wrongRecordRevision.id,blockId: 'caption' });
  await rejectedSource({ kind: 'submission',revisionId: foreignRevision.id,blockId: 'caption' });
  await rejectedSource({ kind: 'submission',revisionId: revisionA.id,blockId: 'missing' });
  await rejectedSource({ kind: 'submission',revisionId: crypto.randomUUID(),blockId: 'caption' });
  await rejectedSource({ kind: 'dataset_annotation',labelId: earlyId,field: 'transcript' });
  const sourceBody = sqlite.prepare('SELECT payload_json FROM source_labels WHERE id=?').get(earlyId).payload_json;
  sqlite.prepare('UPDATE source_labels SET payload_json=? WHERE id=?').run('INVALID_PRIVATE_JSON',earlyId);
  await rejectedSource(refs[1]); // malformed label is also in the requested first source
  sqlite.prepare('UPDATE source_labels SET payload_json=? WHERE id=?').run(sourceBody,earlyId);
  console.log('PASS reference-answer, draft, cross-audio/record/project, missing field/revision, malformed and non-answer source rejection');

  const worker = await sets.forAssignment(db,voteJob.id,'voter');
  assert.equal(worker.candidateSets.vote.candidates.length,3);
  const publicJson = JSON.stringify(worker.candidateSets);
  for (const hidden of ['PRIVATE_AUTHOR','HIDDEN_GROUND_TRUTH','REFERENCE_SECRET','sourceRevisionId','sourceAuthorId','sourceLabelId','createdBy',revisionA.id,'author-a'])
    assert(!publicJson.includes(hidden),hidden);
  const entries = await repo.entries(db,voting.id);
  const fromA = entries.find(entry => entry.sourceRevisionId === revisionA.id);
  const fromB = entries.find(entry => entry.sourceRevisionId === revisionB.id);
  assert(fromA && fromB);
  assert.equal(fromA.sourceTaskInstanceId,sourceTask.id);
  assert.equal(fromA.sourceDefinitionId,sourceDefinition);
  assert.equal(fromA.sourceDefinitionVersion,1);
  assert.equal(fromA.sourceRecordDbId,record);
  assert.equal((await sets.forAssignment(db,ownJob.id,'author-a')).candidateSets.vote.candidates.some(c => c.id === fromA.id),false);
  await assert.rejects(sets.forAssignment(db,voteJob.id,'author-a'),expects(403));
  const selection = { candidateSetSnapshotId: snapshot.id,selectedCandidateId: fromB.id };
  const write = (answers,revision = 0,actor = 'voter') => ({ labellerId: actor,expectedRevision: revision,answers });
  await annotations.save(db,voteJob.id,write({}),'draft');
  for (const bad of [ { ...selection,selectedCandidateId: 'unknown' },
    { ...selection,candidateSetSnapshotId: crypto.randomUUID() },
    { ...selection,sourceRevisionId: revisionA.id }, { value: 'AGREE' },null,[] ])
    for (const status of ['draft','submitted'])
      await assert.rejects(annotations.save(db,voteJob.id,write({ vote: bad },1),status),AnnotationAnswerError);
  await assert.rejects(annotations.save(db,ownJob.id,write({ vote: { ...selection,selectedCandidateId: fromA.id } },0,'author-a'),'submitted'),AnnotationAnswerError);
  await annotations.save(db,voteJob.id,write({ vote: selection },1),'draft');
  await annotations.save(db,voteJob.id,write({ vote: selection },2),'submitted');
  await assert.rejects(annotations.save(db,voteJob.id,write({ vote: selection },2),'submitted'),AnnotationConflictError);
  sqlite.close(); sqlite = new DatabaseSync(filename); sqlite.exec('PRAGMA foreign_keys=ON');
  assert.deepEqual((await annotations.current(db,voteJob.id,'voter')).current.answers.vote,selection);
  assert.equal((await annotations.history(db,voteJob.id,'voter')).length,3);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM annotation_revisions WHERE assignment_id=?').get(voteJob.id).n,3);
  assert.deepEqual(sqlite.prepare('SELECT * FROM source_labels ORDER BY id').all(),labelsBefore);
  for (const original of sourceHistory)
    assert.deepEqual(sqlite.prepare('SELECT * FROM annotation_revisions WHERE id=?').get(original.id),original);
  // Mutable imported labels cannot alter an already captured candidate's meaning.
  sqlite.prepare('UPDATE source_labels SET payload_json=? WHERE id=?').run('{"value":"Changed import"}',earlyId);
  assert.equal((await sets.forAssignment(db,voteJob.id,'voter')).candidateSets.vote.candidates[0].value,'Bird');
  sqlite.prepare('UPDATE source_labels SET payload_json=? WHERE id=?').run(sourceBody,earlyId);
  assert.throws(() => sqlite.prepare("UPDATE candidate_set_entries SET value_json='null' WHERE id=?").run(fromA.id),/CANDIDATE_SET_IMMUTABLE/);
  assert.throws(() => sqlite.prepare('DELETE FROM candidate_set_snapshots WHERE id=?').run(snapshot.id),/CANDIDATE_SET_IMMUTABLE/);
  assert.throws(() => sqlite.prepare('UPDATE task_instances SET asset_id=? WHERE id=?').run(asset2,voting.id),/CANDIDATE_TASK_IDENTITY_IMMUTABLE/);
  console.log('PASS anonymous owner projection, self-vote denial, draft/final eligibility, durable vote/history, pinned imports and untouched source annotations');

  const selfTask = await task(await protocol([{ ...setBlock,allowSelfVote: true }]));
  const selfJob = await job(selfTask,'author-a');
  const selfSet = await sets.create(db,{ ...input,taskInstanceId: selfTask.id,requestId: 'allow-self',sources: refs.slice(1) });
  const selfEntry = (await repo.entries(db,selfTask.id)).find(entry => entry.sourceAuthorId === 'author-a');
  await annotations.save(db,selfJob.id,write({ vote: { candidateSetSnapshotId: selfSet.candidateSet.id,selectedCandidateId: selfEntry.id } },0,'author-a'),'submitted');
  const otherVote = await job(voting,'voter-2');
  await assert.rejects(annotations.save(db,otherVote.id,write({ vote: { candidateSetSnapshotId: snapshot.id,selectedCandidateId: selfEntry.id } },0,'voter-2'),'draft'),AnnotationAnswerError);
  const racing = await Promise.allSettled([0,1].map(() => annotations.save(db,otherVote.id,write({ vote: selection },0,'voter-2'),'draft')));
  assert.equal(racing.filter(r => r.status === 'fulfilled').length,1);
  assert(racing.find(r => r.status === 'rejected').reason instanceof AnnotationConflictError);
  console.log('PASS explicit self-vote policy, cross-set IDs, concurrent annotation revision guards');

  // Exercise real HTTP handlers in memory with the test D1 binding, not mocked responses.
  const createRoute = load('app/api/v1/candidate-sets/route.ts');
  const readRoute = load('app/api/v1/assignments/[id]/candidates/route.ts');
  const submitRoute = load('app/api/v1/assignments/[id]/annotation/submit/route.ts');
  const request = body => new Request('http://localhost/api/v1/candidate-sets',{ method: 'POST',headers: { 'content-type':'application/json' },body: JSON.stringify(body) });
  const ctx = id => ({ params: Promise.resolve({ id }) });
  assert.equal((await createRoute.POST(request(input))).status,200);
  assert.equal((await createRoute.POST(request({ ...input,userId: 'voter' }))).status,403);
  assert.equal((await createRoute.POST(request({ ...input,taskInstanceId: 'bad' }))).status,400);
  assert.equal((await createRoute.POST(request({ ...input,requestId: 'conflict' }))).status,409);
  const response = await readRoute.GET(new Request('http://localhost?labellerId=voter'),ctx(voteJob.id));
  assert.equal(response.status,200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body),['candidateSets']);
  assert(!JSON.stringify(body).includes('sourceAuthorId'));
  assert.equal((await readRoute.GET(new Request('http://localhost?labellerId=author-a'),ctx(voteJob.id))).status,403);
  assert.equal((await readRoute.GET(new Request('http://localhost?labellerId=voter'),ctx(crypto.randomUUID()))).status,404);
  assert.equal((await readRoute.GET(new Request('http://localhost?labellerId=voter'),ctx('bad'))).status,400);
  assert.equal((await submitRoute.POST(request(write({ vote: { ...selection,selectedCandidateId: 'bad' } },1,'voter-2')),ctx(otherVote.id))).status,422);
  assert.equal((await load('app/api/v1/candidate-sets/route.ts',false).POST(request(input))).status,200);
  // Candidate reads now rely on the shared API boundary. Compose the real
  // authorizer with the handler: matching a caller-supplied owner ID is not login.
  const { authorizeApi } = load('lib/backend/auth/api-guard.ts');
  const { digest } = load('lib/backend/auth/identity.ts');
  const settings = { AUTH_MODE: 'demo' };
  const tokens = new Map();
  for (const user of ['voter', 'author-a']) {
    sqlite.prepare('INSERT INTO auth_accounts(user_id,username,display_name) VALUES(?,?,?)').run(user,user,user);
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    tokens.set(user,token);
    sqlite.prepare('INSERT INTO auth_demo_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
      .run(await digest(token),user,Date.now()+60000);
  }
  async function authorizedRead(actor, claimedOwner='voter') {
    const req = new Request(`http://localhost/api/v1/assignments/${voteJob.id}/candidates?labellerId=${claimedOwner}`,
      { headers: actor ? { cookie: 'audiolab_demo='+tokens.get(actor) } : {} });
    return (await authorizeApi(db,req,settings)) ?? readRoute.GET(req,ctx(voteJob.id));
  }
  assert.equal((await authorizedRead()).status,401,'Supplied owner ID alone cannot authenticate');
  assert.equal((await authorizedRead('author-a')).status,403,'Another project member cannot read this assignment');
  assert.equal((await authorizedRead('voter','author-a')).status,403,'Owner cannot impersonate a peer');
  const authorized = await authorizedRead('voter');
  assert.equal(authorized.status,200);
  assert(!JSON.stringify(await authorized.json()).includes('sourceAuthorId'));

  const productionGuard = load('lib/backend/auth/api-guard.ts',false).authorizeApi;
  const productionRequest = new Request(`https://audiolab.example/api/v1/assignments/${voteJob.id}/candidates?labellerId=voter`);
  assert.equal((await productionGuard(db,productionRequest,{
    AUTH_MODE:'access',APP_ORIGIN:'https://audiolab.example',
    ACCESS_TEAM_DOMAIN:'https://test.cloudflareaccess.com',ACCESS_AUDIENCE:'test-audience',
  })).status,401,'Production rejects requests without a verified Access token');
  assert.equal((await productionGuard(db,productionRequest,{AUTH_MODE:'demo'})).status,503,
    'Demo authentication cannot enable production reads');
  // Calling a handler in isolation intentionally omits middleware; it is no
  // longer expected to reject production solely because DEV is false.
  assert.equal((await load('app/api/v1/assignments/[id]/candidates/route.ts',false).GET(
    new Request('http://localhost?labellerId=voter'),ctx(voteJob.id))).status,200);
  const apiTask = await task(await protocol([setBlock]));
  assert.equal((await createRoute.POST(request({ ...input,taskInstanceId: apiTask.id,requestId: 'http-new' }))).status,201);
  const invalidApiTask = await task(await protocol([setBlock]));
  assert.equal((await createRoute.POST(request({ ...input,taskInstanceId: invalidApiTask.id,
    sources: [refs[0],{kind:'dataset_annotation',labelId:referenceId}] }))).status,422);
  // An inconsistent old assignment must not turn membership in one project
  // into permission to see candidate sets from another.
  const mismatch = await job(apiTask,'voter-2');
  await assignments.addMember(db,{ projectId: foreignProject,userId:'voter-2',displayName:'Other membership',role:'labeller' });
  sqlite.prepare('UPDATE assignments SET project_id=? WHERE id=?').run(foreignProject,mismatch.id);
  await assert.rejects(sets.forAssignment(db,mismatch.id,'voter-2'),expects(403));
  sqlite.prepare('UPDATE assignments SET project_id=? WHERE id=?').run(project,mismatch.id);
  console.log('PASS handlers and shared authorization: owner-only reads, anonymous/impersonation denial, production Access required/demo disabled, production handler availability and inconsistent-assignment scope denial');

  // Legacy evaluation remains separate from set selection; no UI changes here.
  const legacyRoute = load('app/api/v1/annotation-candidates/route.ts');
  const curatedResponse = await legacyRoute.POST(request({ projectId: project,assetId: asset,label: 'Curated hypothesis',provenance: 'researcher' }));
  assert.equal(curatedResponse.status,201);
  const curatedId = (await curatedResponse.json()).candidate.id;
  const legacyTask = await task(await protocol([{ ...setBlock,candidateSource: 'curated',options: [{ id:'AGREE',label:'Agree' },{ id:'DISAGREE',label:'Disagree' }] }]));
  const legacyJob = await job(legacyTask);
  assert((await tasks.get(db,legacyTask.id)).candidates.some(c => c.id === curatedId));
  assert.deepEqual((await tasks.get(db,voting.id)).candidates,[]);
  await assert.rejects(annotations.save(db,legacyJob.id,write({ vote: { value: 'AGREE',candidateId:'unknown' } }),'draft'),AnnotationAnswerError);
  await annotations.save(db,legacyJob.id,write({ vote: { value: 'AGREE' } }),'draft');
  await annotations.save(db,legacyJob.id,write({ vote: { value: 'AGREE',candidateId:curatedId } },1),'submitted');
  const mixedTask = await task(await protocol([setBlock]));
  await sets.create(db,{ ...input,taskInstanceId:mixedTask.id,requestId:'curated-source',sources:[refs[0],{kind:'curated',candidateId:curatedId}] });
  console.log('PASS existing curated candidate API/evaluation format and curated sources in immutable sets');

  // Migration order is a C04 concern: it must not consume/rewrite reserved W01.
    // Byte-pinned by test_team_job_migrations; no cached remote ref is required.
  const w01 = fs.readFileSync(path.join(root, 'fixtures/migration-compatibility/w01-workflow.sql.fixture'), 'utf8');
  const c03 = fs.readFileSync(path.join(root,'migrations/0011_task_input_snapshots.sql'),'utf8');
  const c04 = fs.readFileSync(path.join(root,'migrations/0012_candidate_set_snapshots.sql'),'utf8');
  for (const ordered of [[w01,c03,c04],[c04,c03,w01]]) {
    const fixture = new DatabaseSync(':memory:'); fixture.exec('PRAGMA foreign_keys=ON');
    for (const file of fs.readdirSync(path.join(root,'migrations')).filter(file => /^000\d.*\.sql$/.test(file)).sort())
      fixture.exec(fs.readFileSync(path.join(root,'migrations',file),'utf8'));
    fixture.prepare('INSERT INTO projects(id,name,slug) VALUES(?,?,?)').run('preserved','Preserved','preserved');
    for (const migration of ordered) fixture.exec(migration);
    assert.equal(fixture.prepare('SELECT name FROM projects WHERE id=?').get('preserved').name,'Preserved');
    assert.deepEqual(fixture.prepare('PRAGMA foreign_key_check').all(),[]);
    fixture.close();
  }
  // Even direct appends cannot expand a complete snapshot after creation.
  const originalEntry = entries[0];
  assert.throws(() => sqlite.prepare(`INSERT INTO candidate_set_entries
    (id,candidate_set_id,position,source_kind,source_label_id,source_field_id,source_record_db_id,source_updated_at,value_json)
    VALUES(?,?,3,'dataset_annotation',?,'value',?,?,'"extra"')`)
    .run(crypto.randomUUID(),snapshot.id,earlyId,record,originalEntry.sourceUpdatedAt),/CANDIDATE_SET_CONTENT_INVALID/);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  console.log('PASS snapshot append guard and migration order/data preservation with 0010/0011/0012');
  console.log(`Evidence SQLite: ${filename}`);
})().catch(error => { console.error(error); process.exitCode=1; }).finally(() => sqlite.close());
