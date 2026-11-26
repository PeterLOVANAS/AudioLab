/** Preflight reports why Preview cannot proceed, without creating assignments. */
const fs=require('node:fs'),ts=require('@typescript/typescript6'),assert=require('node:assert/strict'),m={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync('lib/frontend/job-preview-readiness.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m,m.exports);
const {jobPreviewProblems}=m.exports;
const ready={name:'Assignment',protocol:'definition:1',datasetId:'dataset',workers:['alice','bob'],keys:['a','b'],sampleCount:2,seed:'seed',mode:'voting'};
assert.deepEqual(jobPreviewProblems(ready),[]);
for(const [field,value] of [['name','  '],['protocol',''],['datasetId',''],['workers',[]],['keys',[]],['seed','']])assert(jobPreviewProblems({...ready,[field]:value}).length,field);
assert(jobPreviewProblems({...ready,sampleCount:3}).some(x=>x.includes('reduce')));
assert(jobPreviewProblems({...ready,sampleCount:1.5}).some(x=>x.includes('whole')));
assert(jobPreviewProblems({...ready,workers:Array(21).fill('worker')}).some(x=>x.includes('20')));
assert(jobPreviewProblems({...ready,keys:Array(50).fill('item'),sampleCount:50,workers:Array(20).fill('worker')}).some(x=>x.includes('500')));
assert.deepEqual(jobPreviewProblems({...ready,keys:Array(8).fill('item'),sampleCount:8,recordingsPerTask:4}),[]);
assert.deepEqual(jobPreviewProblems({...ready,keys:Array(10).fill('item'),sampleCount:10,recordingsPerTask:4}),[]);
assert.deepEqual(jobPreviewProblems({...ready,keys:[],sampleCount:100,recordingsPerTask:4,useEntireDataset:true}),[]);
console.log('PASS ready form, all formerly silent missing fields, whitespace name/seed, fractional/oversized sample, worker limit and Voting assignment bound.');
