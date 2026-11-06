/**
 * Standalone, dependency-light regression test for Task Builder extensions.
 * Run: node scripts/test_builder_extensions.cjs
 *
 * TypeScript is already a dev dependency of the Vinext project. We transpile
 * ONLY pure model/validator modules into memory to test their runtime logic;
 * React, Cloudflare, and D1 are not needed for these specific cases.
 * This intentionally does NOT replace running `tsc --noEmit` or HTTP tests.
 */


// TypeScript 7 uses a native compiler and does not expose
// the traditional JavaScript Compiler API.
//
// This regression test needs transpileModule(), ModuleKind,
// and ScriptTarget to execute individual TypeScript modules.
//
// We use the TypeScript 6 compatibility package only here.
// The application can continue using TypeScript 7 for type-checking.
const ts = require("@typescript/typescript6");
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
function load(filename) {
  const code=fs.readFileSync(path.join(root,filename),'utf8');
  const result=ts.transpileModule(code,{fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
  const mod={exports:{}};
  const localRequire=(name)=>{
    if(name==='./timeline-answers')return load('lib/backend/validation/timeline-answers.ts');
    throw Error('Unexpected runtime import '+name+' from '+filename);
  };
  new Function('require','module','exports',result.outputText)(localRequire,mod,mod.exports);
  return mod.exports;
}
const model=load('components/task-builder/model.ts');
const answerCheck=load('lib/backend/validation/annotation-answers.ts');
const timeline=load('lib/backend/validation/timeline-answers.ts');
const defs={ id:'d',version:1,name:'Test',description:'',domain:'speech',instructions:'Test',policy:{requiredIndependentVotes:1,blindToOthers:true,requiresReview:false},blocks:[] };
const choice=model.newBlock('single_choice');choice.options=[{id:'present',label:'Present'},{id:'absent',label:'Absent'}];
const callout=model.newBlock('callout');callout.showWhen={blockId:choice.id,equals:'absent'};
const confirmation=model.newBlock('boolean');confirmation.requiredValue=true;confirmation.showWhen={blockId:choice.id,equals:'absent'};
const section=model.newBlock('section');
const audio=model.newBlock('audio_player');
const annotation=model.newBlock('timeline_annotation');
const summary=model.newBlock('transcript_summary'); summary.sourceTimelineBlockId=annotation.id; summary.summaryMode='both';
assert.equal(annotation.tiers.length,2);
const draft={...model.blankDraft(),name:'Test',instructions:'Listen',blocks:[section,audio,choice,callout,confirmation,annotation,summary]};
assert.deepEqual(model.checkDraft(draft),[],'Complex definitions must be locally valid');
assert.equal(model.publishLimit(annotation),undefined,'A validated timeline can publish');
assert.equal(model.publishLimit(summary),undefined,'A derived summary can publish');
assert.equal(model.checkDraft({...draft,blocks:[summary,annotation]}).length>0,true,'Summary must follow its source');
assert.equal(model.publishLimit(model.newBlock('ranking'))!==undefined,true,'Ranking still preview-only');
// Conditional callouts create no answer field. If the prior choice changes,
// the labeller must omit stale confirmation values.
const definition={...defs,blocks:[section,audio,choice,callout,confirmation]};
assert.deepEqual(answerCheck.validateAnswers(definition,{[choice.id]:'present'},true),[]);
assert.deepEqual(answerCheck.validateAnswers(definition,{[choice.id]:'absent',[confirmation.id]:true},true),[]);
assert(answerCheck.validateAnswers(definition,{[choice.id]:'absent',[confirmation.id]:false},true).some(e=>e.message.includes('required value')));
assert(answerCheck.validateAnswers(definition,{[choice.id]:'present',[confirmation.id]:true},true).some(e=>e.message.includes('hidden')));
assert(answerCheck.validateAnswers(definition,{[choice.id]:'present',[section.id]:'wrong'},true).some(e=>e.message.includes('Display-only')));
const tiers=annotation.tiers;
const valid={tiers:{words:[{id:'w1',start:.3,end:1.0,text:'hello',speaker:'Speaker 1'}],phones:[{id:'p1',start:.35,end:.43,text:'h',speaker:'Speaker 1',parentId:'w1'}]}};
assert.deepEqual(timeline.validateTimelineAnswer(tiers,valid,true,true),[]);
assert.deepEqual(answerCheck.validateAnswers({...defs,blocks:[annotation,summary]},{[annotation.id]:valid},true),[]);
assert(timeline.validateTimelineAnswer(tiers,{tiers:{words:[{id:'w1',start:1,end:0,text:'bad'}],phones:[]}},true,true).length>0);
assert(timeline.validateTimelineAnswer(tiers,{tiers:{words:[{id:'w1',start:0,end:1,text:'ok'}],phones:[{id:'p1',start:0,end:.2,text:'p',parentId:'missing'}]}},true,true).length>0);
assert(timeline.validateTimelineAnswer(tiers,{tiers:{}},true,true).length>0);
console.log('PASS: display-only blocks, conditional confirmation, timeline answers, preview-only limitations.');
