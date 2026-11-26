/** Focused regressions for the three final-review findings; no app state or browser. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const ts = require('@typescript/typescript6');
const root = path.resolve(__dirname, '..');
function load(file) {
  const mod = {exports:{}};
  const code = ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  new Function('require','exports','module',code)(name=>name.startsWith('@/')?load(name.slice(2)+'.ts'):require(name),mod.exports,mod);
  return mod.exports;
}
const {ingestionSchema} = load('lib/backend/validation/dataset-ingestion.ts');
const {compareBlock} = load('lib/backend/services/agreement.ts');
const sample = JSON.parse(fs.readFileSync(path.join(root,'docs/examples/canonical-ingestion.json'),'utf8'));
const badChoices = {type:'choices',visibility:'worker',value:[{id:'same',label:'A'},{id:'same',label:'B'}]};
function rejected(data, expectedPath) {
  const result=ingestionSchema.safeParse(data);
  assert.equal(result.success,false);
  assert(result.error.issues.some(issue=>issue.path.join('.')===expectedPath));
}
const shadowed=structuredClone(sample);
shadowed.records[0].fields.choices=badChoices;
rejected(shadowed,'records.0.fields.choices.value');
const item=structuredClone(sample);item.records[0].items[0].fields.choices=badChoices;
rejected(item,'records.0.items.0.fields.choices.value');
const both=structuredClone(item);both.records[0].fields.choices=badChoices;
rejected(both,'records.0.fields.choices.value');rejected(both,'records.0.items.0.fields.choices.value');
const other=structuredClone(sample);other.records[0].fields.otherChoices=badChoices;
rejected(other,'records.0.fields.otherChoices.value');
assert(ingestionSchema.safeParse(sample).success);
console.log('PASS choice uniqueness in sample/item/shadowed/other collections and exact error paths');
const group={id:'g',type:'repeated_group',blocks:[{id:'optional',type:'text',required:false}]};
const entries=answers=>[{id:'entry',answers}];
let result=compareBlock(group,entries({}),entries({}));
assert.deepEqual(result,{exact:false,similarity:0,comparedCount:0,skippedCount:1});
result=compareBlock(group,entries({optional:'Answer'}),entries({}));
assert.equal(result.exact,false);assert.equal(result.similarity,0);assert.equal(result.comparedCount,1);
result=compareBlock(group,entries({}),entries({optional:'Answer'}));assert.equal(result.similarity,0);
result=compareBlock(group,entries({optional:' Answer '}),entries({optional:'answer'}));
assert.equal(result.exact,true);assert.equal(result.similarity,1);
const mixed={...group,blocks:[...group.blocks,{id:'display',type:'callout'},{id:'answer',type:'boolean',required:true}]};
result=compareBlock(mixed,entries({answer:true}),entries({answer:true}));
assert.deepEqual(result,{exact:true,similarity:1,comparedCount:1,skippedCount:2});
assert.throws(()=>compareBlock({...group,blocks:[{id:'required',type:'text',required:true}]},entries({}),entries({})),/Required/);
const nested={id:'outer',type:'repeated_group',blocks:[group,{id:'b',type:'boolean'}]};
result=compareBlock(nested,entries({g:entries({}),b:true}),entries({g:entries({}),b:true}));
assert.deepEqual(result,{exact:true,similarity:1,comparedCount:1,skippedCount:1});
result=compareBlock(nested,entries({g:entries({optional:'x'}),b:true}),entries({g:entries({optional:'y'}),b:true}));
assert.equal(result.exact,false);assert.equal(result.comparedCount,2);assert.equal(result.similarity,0.5);
console.log('PASS optional missing/asymmetric/display-only/nested agreement; no false 100% on no evidence');
