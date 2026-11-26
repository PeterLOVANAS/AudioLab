/** Browser draft contracts: restoration, privacy scope and corrupt data errors. */
const fs=require('node:fs'),ts=require('@typescript/typescript6'),assert=require('node:assert/strict');
const m={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('lib/frontend/team-job-draft.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(require,m,m.exports);
const {readTeamJobDraft,saveTeamJobDraft}=m.exports;
const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
const draft={name:'Team assignment',teamId:'team',teamName:'Linguists',workers:['alice','bob'],datasetId:'pes',protocol:'definition:1',mode:'voting',seed:'seed',sampleCount:10,keys:['item1','item2']};
saveTeamJobDraft(storage,'admin','project',draft);
assert.deepEqual(readTeamJobDraft(storage,'admin','project'),draft);
saveTeamJobDraft(storage,'admin','entire',{...draft,useEntireDataset:true});assert.equal(readTeamJobDraft(storage,'admin','entire').useEntireDataset,true);
assert.equal(readTeamJobDraft(storage,'bob','project'),null);assert.equal(readTeamJobDraft(storage,'admin','other-project'),null);
assert.throws(()=>saveTeamJobDraft(storage,'admin','project',{...draft,keys:Array(51).fill('item')}));
assert.throws(()=>saveTeamJobDraft({setItem(){throw Error('quota')}},'admin','project',draft));
values.set([...values.keys()][0],'{bad');assert.throws(()=>readTeamJobDraft(storage,'admin','project'));
console.log('PASS configuration draft round trip, worker/item selection, account/project isolation, bounds, corrupt storage and quota failures.');
