/** Deterministic complete audio packing, including multiple items per audio. */
const fs=require('node:fs'),ts=require('@typescript/typescript6'),assert=require('node:assert/strict'),m={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync('lib/contracts/task-batches.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m,m.exports);
const {packTaskBatches,requiredTaskRecordings}=m.exports;
assert.equal(requiredTaskRecordings([{type:'single_choice',numBatch:4},{type:'text',numBatch:2}]),4);
assert.equal(requiredTaskRecordings([{type:'ranking',rankingMode:'audio',stimulusSlots:['a','b'],numBatch:4}]),4);
for(let n=1;n<=5;n++)for(let batches=1;batches<=6;batches++){
 const items=Array.from({length:n*batches},(_,i)=>({key:'item'+i,assetId:'audio'+(i%n)}));
 const packed=packTaskBatches(items,n);assert.equal(packed.length,batches);
 assert.deepEqual(new Set(packed.flat().map(x=>x.key)),new Set(items.map(x=>x.key)));
 for(const batch of packed){assert.equal(batch.length,n);assert.equal(new Set(batch.map(x=>x.assetId)).size,n);}
 assert.deepEqual(packTaskBatches([...items],n),packed);
}
assert.deepEqual(packTaskBatches([{key:'a',assetId:'a'}],2).map(batch=>batch.length),[1]);
assert.deepEqual(packTaskBatches(Array.from({length:10},(_,i)=>({key:''+i,assetId:''+i})),4).map(batch=>batch.length),[4,4,2]);
assert.throws(()=>packTaskBatches(Array.from({length:4},(_,i)=>({key:''+i,assetId:i<3?'same':'other'})),2),/distinct/);
assert.throws(()=>packTaskBatches([],0),/1–24/);
const legacy=[{key:'x',assetId:'b'},{key:'y',assetId:'a'},{key:'z',assetId:'a'}];assert.deepEqual(packTaskBatches(legacy,1).flat(),legacy);
assert.throws(()=>packTaskBatches([{key:'same',assetId:'a'},{key:'same',assetId:'b'}],2),/Duplicate/);
console.log('PASS shared recording requirement, 30 packing combinations, deterministic complete coverage, distinct audio slots, partial final batches and impossible repeated-audio rejection.');
