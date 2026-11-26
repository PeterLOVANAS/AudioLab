/** Ingestion + binding + architecture corrections: real services/handlers and SQL on a disposable on-disk SQLite DB.
 * No browser, build, precious state or remote D1. Run: node scripts/test_ingestion_integration.cjs
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
const {ingestDataset,inspectImport}=load('lib/backend/services/dataset-ingestion.ts');
const {adaptMmau}=load('lib/backend/services/mmau-adapter.ts');
const {resolveSourceFields}=load('lib/backend/services/source-fields.ts');
const {resolveBoundBlocks}=load('lib/frontend/source-binding.ts');
const {annotationPreview}=load('lib/frontend/annotation-preview.ts');
const agreement=load('lib/backend/services/agreement.ts');
const BlockFields=load('components/workbench/BlockFields.tsx').default;
const {Palette}=load('components/task-builder/BlockEditor.tsx');
const {renderToStaticMarkup}=require('react-dom/server');const React=require('react');
const {ingestionRoute}=load('lib/backend/http/ingestion-routes.ts');
(async()=>{
 sqlite.prepare('INSERT INTO projects(id,name,slug) VALUES(?,?,?)').run(project,'Ingest',project);
 sqlite.prepare('INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)').run(dataset,project,'Fixture','1');
 sqlite.prepare("INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key) VALUES(?,?,?,'r2',?)").run(asset,dataset,'recording.wav','recording.wav');
 for(const [user,role] of [['admin','admin'],['voter','labeller']])await assignments.addMember(db,{projectId:project,userId:user,displayName:user,role});
 const data=adaptMmau(dataset,'v1',[{id:'sample',audioId:asset,question:'What sound?',choices:['Bird','Wind','Rain','Speech'],answer:'Bird',annotation:'Birdsong'}]);
 data.records[0].items.push({...structuredClone(data.records[0].items[0]),item_id:'question-2',annotations:[],fields:{question:{type:'text',visibility:'worker',value:'Which weather?'},choices:{type:'choices',visibility:'worker',value:[{id:'dry',label:'Dry'},{id:'wet',label:'Wet'}]}},reference:{field:'choices',value:'wet'}});
 const otherSample=structuredClone(data.records[0]);otherSample.sample_id='second-sample';otherSample.items=[structuredClone(otherSample.items[1])];otherSample.fields.instruction.value='Second sample instructions';otherSample.items[0].fields.question.value='Second sample weather?';data.records.push(otherSample);
 const run=(input,persist=false)=>ingestDataset(db,project,'admin',input,persist);
 assert((await run(data)).ok);assert.equal(sqlite.prepare('SELECT count(*) n FROM source_records').get().n,0);
 const imported=await run(data,true);assert(imported.ok);assert.equal(imported.accepted.length,3);
 assert((await run(data,true)).ok);assert.equal(sqlite.prepare('SELECT count(*) n FROM source_records').get().n,3);
 const conflict=structuredClone(data);conflict.records[0].items[0].fields.question.value='Changed';assert.equal((await run(conflict,true)).ok,false);
 for(const change of [d=>d.records.push(d.records[0]),d=>d.records[0].items.push(d.records[0].items[0]),d=>d.records[0].audio_id=crypto.randomUUID(),d=>d.records[0].items[0].fields={},d=>d.records[0].items[0].reference.value='bad']){
  const bad=structuredClone(data);change(bad);assert.equal((await run(bad,true)).ok,false);
 }
 await assert.rejects(ingestDataset(db,project,'voter',data,true),e=>e.status===403);
 const routeImport=await ingestionRoute(new Request(`http://localhost/import?projectId=${project}&userId=admin`,{method:'POST',body:JSON.stringify(data)}),'import');assert.equal(routeImport.status,200);
 const deniedOrigin=await ingestionRoute(new Request('http://localhost/import',{method:'POST',headers:{origin:'https://evil.example'},body:'{}'}),'import');assert.equal(deniedOrigin.status,403);
 const badJson=await ingestionRoute(new Request('http://localhost/validate',{method:'POST',body:'{'}),'validate');assert.equal(badJson.status,400);
 // Handler-only parsing is environment independent; built-Worker Access/CSRF
 // denial is verified in test_production_security.cjs before reaching this handler.
 const prod=load('lib/backend/http/ingestion-routes.ts',false);assert.equal((await prod.ingestionRoute(new Request('http://localhost/validate'),'validate')).status,400);
 assert.equal((await ingestionRoute(new Request('https://example.com/validate'),'validate')).status,400);
 const record=imported.accepted[0].source_record_id;
 const inspect=await inspectImport(db,project,'admin',dataset,record,asset);assert.equal(inspect.item.fields.question.value,'What sound?');
 assert.equal(JSON.parse(inspect.labels.find(l=>l.kind==='reference_answer').payloadJson).value,'choice-1');
 const viewer={projectId:project,userId:'admin',role:'admin'};
 const admin=await resolveSourceFields(db,viewer,dataset,record,'admin',asset);assert.equal(annotationPreview(admin).kind,'actual');
 const worker=await resolveSourceFields(db,{...viewer,userId:'voter',role:'labeller'},dataset,record,'worker',asset);
 assert(!JSON.stringify(worker).includes('original_answer'));assert(!worker.fields.some(f=>f.field.id==='reference_answer'||f.field.id==='early_annotation'));
 assert.equal(annotationPreview(worker).kind,'unavailable');
 const secondAdmin=await resolveSourceFields(db,viewer,dataset,imported.accepted[1].source_record_id,'admin',asset);assert.equal(annotationPreview(secondAdmin).kind,'mock');
 console.log('PASS canonical dry-run/import/inspect, malformed/duplicate/missing/reference rejection, idempotency/conflict, original annotation and privacy');
 const binding=(fieldId,type='string')=>({kind:'dataset',fieldId,type});
 const blocks=[{id:'question',type:'single_choice',label:'Bound question',required:true,sourceBindings:{label:binding('item.question'),options:binding('item.choices','choices')}},
 {id:'context',type:'text',label:'Question only',required:false,sourceBindings:{value:{...binding('item.question'),mode:'read_only'}}}];
 const def=await definitions.create(db,project,taskDraftSchema.parse({...common,instructionBinding:binding('sample.instruction'),blocks}));await definitions.publish(db,def.id,1,0);
 for(const [index,r] of imported.accepted.entries()){
  const t=await task(def.id,asset,r.source_record_id);assert.equal(t.resolvedDefinition.instructions,index===2?'Second sample instructions':'Listen and answer');
  assert.equal(t.resolvedDefinition.blocks[0].label,index===2?'Second sample weather?':index?'Which weather?':'What sound?');
  assert.equal(t.resolvedDefinition.blocks[1].type,'callout');
  const rendered=renderToStaticMarkup(React.createElement(BlockFields,{blocks:t.resolvedDefinition.blocks,answers:{},onChange:()=>{}}));
  assert(rendered.includes(index===2?'Second sample weather?':index?'Which weather?':'What sound?'));
  assert(rendered.includes(index?'Wet':'Bird'));if(index)assert(!rendered.includes('Bird'));
  const id=index?'wet':'choice-1';assert(t.resolvedDefinition.blocks[0].options.some(o=>o.id===id));
  const j=await job(t);await assert.rejects(annotations.save(db,j.id,{labellerId:'voter',expectedRevision:0,answers:{question:'unknown'}},'submitted'),AnnotationAnswerError);
  await annotations.save(db,j.id,{labellerId:'voter',expectedRevision:0,answers:{question:id}},'draft');await annotations.save(db,j.id,{labellerId:'voter',expectedRevision:1,answers:{question:id}},'submitted');
  assert.equal((await annotations.current(db,j.id,'voter')).current.answers.question,id);
 }
 assert.throws(()=>resolveBoundBlocks([{...blocks[0],sourceBindings:{label:binding('item.missing')}}],worker));
 assert.equal(resolveBoundBlocks([textBlock],worker)[0],textBlock);
 assert.throws(()=>sqlite.prepare('UPDATE source_records SET question=? WHERE id=?').run('overwrite',imported.accepted[0].id),/IMMUTABLE/);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM audio_assets').get().n,1);
 const multiDef=await definitions.create(db,project,taskDraftSchema.parse({...common,blocks:[{...blocks[0],type:'multiple_choice'}]}));await definitions.publish(db,multiDef.id,1,0);
 const multiTask=await task(multiDef.id,asset,record),multiJob=await job(multiTask);
 await annotations.save(db,multiJob.id,{labellerId:'voter',expectedRevision:0,answers:{question:['choice-1','choice-2']}},'submitted');
 assert.deepEqual((await annotations.current(db,multiJob.id,'voter')).current.answers.question,['choice-1','choice-2']);
 console.log('PASS one definition / two same-audio items, explicit paths/instructions/choices, read-only display, draft/submit/reopen and missing fields');
 const group={id:'group',type:'repeated_group',label:'Events',required:true,itemLabel:'Event',minItems:1,maxItems:2,blocks:[textBlock]};
 const g=await task(await protocol([group]),asset,null);const gj=await job(g);
 for(const value of [[],[{id:'x',answers:{caption:'A'}},{id:'x',answers:{caption:'B'}}],[{id:'x',answers:{caption:4}}],[{id:'x',answers:{unknown:'A'}}]])await assert.rejects(annotations.save(db,gj.id,{labellerId:'voter',expectedRevision:0,answers:{group:value}},'submitted'),AnnotationAnswerError);
 const repeated=[{id:'b',answers:{caption:'B'}},{id:'a',answers:{caption:'A'}}];
 await annotations.save(db,gj.id,{labellerId:'voter',expectedRevision:0,answers:{group:repeated}},'draft');await annotations.save(db,gj.id,{labellerId:'voter',expectedRevision:1,answers:{group:repeated}},'submitted');
 assert.deepEqual((await annotations.current(db,gj.id,'voter')).current.answers.group,repeated);
 const nested={...group,blocks:[{...group,id:'nested'}]};assert(taskDraftSchema.safeParse({...common,blocks:[nested]}).success);
 const {validateAnswers}=load('lib/backend/validation/annotation-answers.ts');assert(validateAnswers({blocks:[nested]},{group:[{id:'outer',answers:{nested:[{id:'inner',answers:{caption:42}}]}}]},true).length);
 const nestedTask=await task(await protocol([nested]),asset,null),nestedJob=await job(nestedTask);
 const nestedAnswers={group:[{id:'outer',answers:{nested:[{id:'inner',answers:{caption:'Nested saved'}}]}}]};
 await annotations.save(db,nestedJob.id,{labellerId:'voter',expectedRevision:0,answers:nestedAnswers},'draft');
 await annotations.save(db,nestedJob.id,{labellerId:'voter',expectedRevision:1,answers:nestedAnswers},'submitted');
 assert.deepEqual((await annotations.current(db,nestedJob.id,'voter')).current.answers,nestedAnswers);
 const html=renderToStaticMarkup(React.createElement(Palette,{add:()=>{}}));assert(html.includes('Add Ranking'));assert(html.includes('Add Repeated group'));assert(!html.includes('Add Candidate vote'));
 await assert.rejects(definitions.create(db,project,taskDraftSchema.parse({...common,blocks:[setBlock]})),/deprecated/);
 assert.equal(agreement.jaccard(['a','b'],['b','a']),1);assert.equal(agreement.jaccard(['a'],['b']),0);
 assert.equal(agreement.rankingAgreement(['a','b'],['b','a']),0);assert.equal(agreement.exactVotes([true,true]).unanimous,true);
 assert.equal(agreement.editDistance(agreement.normalizedText(' HELLO  World '),'hello world'),0);
 assert.equal(agreement.temporalIoU({start:0,end:2,label:'a'},{start:1,end:3,label:'a'}),1/3);
 assert.equal(agreement.intervalAgreement([{start:0,end:1,label:'a'},{start:2,end:3,label:'b'}],[{start:2,end:3,label:'b'},{start:0,end:1,label:'a'}]),1);
 const scoped={projectId:project,datasetId:dataset,itemId:'q',audioId:asset,definitionId:'d',definitionVersion:1,blockId:'choices',revisionId:'a',actorId:'a',value:['one','two']};
 assert(agreement.compareScopedAnswers({id:'choices',type:'multiple_choice'},scoped,{...scoped,actorId:'b',revisionId:'b',value:['two','one']}).exact);
 assert.throws(()=>agreement.compareScopedAnswers({id:'choices',type:'multiple_choice'},scoped,{...scoped,itemId:'wrong',actorId:'b',revisionId:'b'}));
 assert(agreement.compareBlock({...group},[{answers:{caption:' HELLO '}}],[{answers:{caption:'hello'}}]).exact);
 assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
 console.log('PASS manual groups/drafts/reorder/reopen/nested negatives, Ranking palette, voting deprecation and block-aware agreement');
 console.log('SQLite evidence:',filename);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>sqlite.close());
