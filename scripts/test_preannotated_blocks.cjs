/** Ingestion + binding + architecture corrections: real services/handlers and SQL on a disposable on-disk SQLite DB.
 * No browser, build, precious state or remote D1. Run: node scripts/test_preannotated_blocks.cjs
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

const {ingestDataset}=load('lib/backend/services/dataset-ingestion.ts');
const {resolveSourceFields}=load('lib/backend/services/source-fields.ts');
const {blockFromSource}=load('lib/frontend/source-blocks.ts');
const {resolveBoundBlocks,initialBoundAnswers,startingAssignmentAnswers}=load('lib/frontend/source-binding.ts');
const {writeTextGrid}=load('lib/audio/textgrid.ts');
const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
const Fields=load('components/workbench/BlockFields.tsx').default;
(async()=>{
 sqlite.prepare('INSERT INTO projects(id,name,slug) VALUES(?,?,?)').run(project,'Source mapping',project);
 sqlite.prepare('INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)').run(dataset,project,'General dataset','1');
 sqlite.prepare("INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key,duration_seconds) VALUES(?,?,?,'r2',?,5)").run(asset,dataset,'test.wav','test.wav');
 for(const [user,role] of [['admin','admin'],['voter','labeller']])await assignments.addMember(db,{projectId:project,userId:user,displayName:user,role});
 const grid=writeTextGrid([{name:'Events',items:[{start:0,end:1,text:'Bird'}]}],5);
 const field=(type,value)=>({type,value,visibility:'worker'});
 const raw={schema_version:1,dataset_id:dataset,source_version:'v1',provenance:{origin:'general',revision:'1'},records:[{sample_id:'a',audio_id:asset,items:[{item_id:'a',fields:{prompt:field('text','First prompt'),description:field('text','Listen carefully'),options:field('choices',[{id:'a',label:'Bird'},{id:'b',label:'Rain'},{id:'c',label:'Wind'}]),caption:field('text','Pre-existing caption'),alignment:field('textgrid',grid)},reference:{field:'options',value:'a'}}]}]};
 const originalBytes=Buffer.from(grid,'utf8');
 raw.records[0].items[0].fields.alignment.file={name:'example.TextGrid',media_type:'text/praat-textgrid',encoding:'utf-8',sha256:require('node:crypto').createHash('sha256').update(originalBytes).digest('hex'),content_base64:originalBytes.toString('base64')};
 const tampered=structuredClone(raw);tampered.records[0].items[0].fields.alignment.file.sha256='0'.repeat(64);
 assert.equal((await ingestDataset(db,project,'admin',tampered,false)).ok,false);
 const utf16=structuredClone(raw);utf16.source_version='utf16-proof';const utf16Bytes=Buffer.concat([Buffer.from([255,254]),Buffer.from(grid,'utf16le')]);
 utf16.records[0].items[0].fields.alignment.file={...utf16.records[0].items[0].fields.alignment.file,encoding:'utf-16le',sha256:require('node:crypto').createHash('sha256').update(utf16Bytes).digest('hex'),content_base64:utf16Bytes.toString('base64')};
 assert((await ingestDataset(db,project,'admin',utf16,false)).ok);

 raw.records[0].items[0].fields.packedChoices=field('text',JSON.stringify(['A, with punctuation','B','C']));
 const imported=await ingestDataset(db,project,'admin',raw,true);assert(imported.ok);
 const record=imported.accepted[0].source_record_id;
 const storedFile=JSON.parse(sqlite.prepare('SELECT canonical_json AS json FROM source_records WHERE id=?').get(imported.accepted[0].id).json).fields.alignment.file;
 assert(Buffer.from(storedFile.content_base64,'base64').equals(originalBytes));

 const source=await resolveSourceFields(db,{projectId:project,userId:'admin',role:'admin'},dataset,record,'admin',asset);
 const choice=blockFromSource(source,'item.options',{questionId:'item.prompt',descriptionId:'item.description'});
 const text=blockFromSource(source,'item.caption',{editableText:true});
 const timeline=blockFromSource(source,'item.alignment');
 const display=blockFromSource(source,'item.prompt');
 assert.throws(()=>blockFromSource(source,'reference_answer'));
 assert.equal(blockFromSource(source,'item.options',{multipleChoices:true}).type,'multiple_choice');
 const blocks=[choice,text,timeline,display];
 const parsed=taskDraftSchema.parse({...common,blocks});
 const def=await definitions.create(db,project,parsed);await definitions.publish(db,def.id,1,0);
 const t=await task(def.id,asset,record);assert.equal(t.resolvedDefinition.blocks[0].options.length,3);
 assert.equal(t.resolvedDefinition.blocks[0].label,'First prompt');
 assert.equal(t.resolvedDefinition.blocks[0].helpText,'Listen carefully');
 assert.equal(t.initialAnswers[text.id],'Pre-existing caption');
 assert.equal(t.initialAnswers[timeline.id].tiers['grid-1'][0].text,'Bird');
 assert.equal(t.resolvedDefinition.blocks[3].type,'callout');
 const j=await job(t);const answers={...t.initialAnswers,[choice.id]:'b'};
 await annotations.save(db,j.id,{labellerId:'voter',expectedRevision:0,answers},'draft');
 await annotations.save(db,j.id,{labellerId:'voter',expectedRevision:1,answers},'submitted');
 assert.deepEqual((await annotations.current(db,j.id,'voter')).current.answers,answers);
 assert.deepEqual(startingAssignmentAnswers(t,{answers:{}}),{});
 const changed=structuredClone(source);changed.fields.find(f=>f.field.id==='item.caption').value='Different record';
 assert.equal(initialBoundAnswers(resolveBoundBlocks(blocks,changed))[text.id],'Different record');
 const extra=structuredClone(raw);extra.records[0].items[0].item_id='second';assert((await ingestDataset(db,project,'admin',extra,true)).ok);
 const queueRoute=load('app/api/v1/labeller/audio-queue/route.ts');
 const query=new URLSearchParams({projectId:project,labellerId:'voter',datasetId:dataset,definitionId:def.id,limit:'1'});
 const first=await queueRoute.GET(new Request('http://localhost/api/v1/labeller/audio-queue?'+query));assert.equal(first.status,200);
 const page=await first.json();assert.equal(page.totalItems,2);assert.equal(page.totalAudio,1);assert.equal(page.groups.length,1);assert(page.hasMore);
 query.set('cursor',page.nextCursor);
 const otherPage=await (await queueRoute.GET(new Request('http://localhost/api/v1/labeller/audio-queue?'+query))).json();
 assert.notEqual(otherPage.groups[0].key,page.groups[0].key);
 const selected=[...page.groups,...otherPage.groups];const jobs=[];
 for(const group of selected){
  const request=()=>new Request('http://localhost/api/v1/labeller/audio-queue',{method:'POST',body:JSON.stringify({projectId:project,labellerId:'voter',datasetId:dataset,definitionId:def.id,definitionVersion:1,assetIds:[asset],sourceRecordId:group.sourceRecordId})});
  const response=await queueRoute.POST(request());assert.equal(response.status,200);const value=await response.json();jobs.push(value.assignment.id);
  assert.equal((await (await queueRoute.POST(request())).json()).assignment.id,value.assignment.id);
 }
 assert.notEqual(jobs[0],jobs[1]);
 console.log('PASS item-aware audio queue: two items on one audio, pagination, distinct assignments and idempotent reopening');
 const packed={...choice,id:'packed',sourceBindings:{options:{kind:'dataset',fieldId:'item.packedChoices',type:'string',format:'json'}}};
 const packedDef=await definitions.create(db,project,taskDraftSchema.parse({...common,blocks:[packed]}));await definitions.publish(db,packedDef.id,1,0);
 const packedTask=await task(packedDef.id,asset,record);assert.equal(packedTask.resolvedDefinition.blocks[0].options[0].label,'A, with punctuation');
 const packedJob=await job(packedTask);
 await assert.rejects(annotations.save(db,packedJob.id,{labellerId:'voter',expectedRevision:0,answers:{packed:'forged'}},'submitted'),AnnotationAnswerError);
 await annotations.save(db,packedJob.id,{labellerId:'voter',expectedRevision:0,answers:{packed:'source-choice-2'}},'submitted');
 assert.equal((await annotations.current(db,packedJob.id,'voter')).current.answers.packed,'source-choice-2');
 const Controls=load('components/task-builder/BlockSourceSettings.tsx').default;
 const markup=renderToStaticMarkup(React.createElement(Controls,{block:packed,fields:source.fields.map(f=>f.field),values:source.fields,onChange:()=>{}}));
 assert(markup.includes('Stored choices format'));assert(markup.includes('A, with punctuation'));
 const normalize=load('lib/frontend/choice-source.ts').normalizeSourceChoices;
 assert.deepEqual(normalize('A) Alpha\nB) Beta','lines',undefined,true).map(v=>v.label),['Alpha','Beta']);
 assert.deepEqual(normalize('one||two||three','delimiter','||').map(v=>v.label),['one','two','three']);
 assert.throws(()=>normalize('[broken','json'));assert.throws(()=>normalize('one|two','delimiter',''));
 console.log('PASS original TextGrid bytes/checksum, per-block JSON/line/delimiter choices, authoritative submission and controls SSR');
 const invalid=structuredClone(raw);invalid.records[0].items[0].fields.alignment.value='not a TextGrid';assert.equal((await ingestDataset(db,project,'admin',invalid,false)).ok,false);
 const hidden=await resolveSourceFields(db,{projectId:project,userId:'voter',role:'labeller'},dataset,record,'worker',asset);
 assert(!hidden.fields.some(f=>f.field.id==='reference_answer'));
 const legacy=load('lib/backend/services/source-fields.ts').projectPublicSourceFields({assetId:asset,question:'Legacy',choicesJson:JSON.stringify(['one','two','three'])});
 assert.equal(resolveBoundBlocks([{...choice,sourceBindings:{options:{kind:'dataset',fieldId:'choices',type:'string[]'}}}],legacy)[0].options.length,3);
 assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
 console.log('PASS typed text/description/3-choice/TextGrid -> automatic blocks -> publish -> assignment -> prefill -> draft/final/reopen, switching and privacy');
 console.log('Disposable SQLite:',filename);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>sqlite.close());
