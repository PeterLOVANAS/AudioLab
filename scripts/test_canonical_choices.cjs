/** Focused regressions for the canonical choice validation; no app state or browser. */
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
