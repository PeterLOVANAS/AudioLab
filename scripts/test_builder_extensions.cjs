/**
 * Standalone, dependency-light regression test for Task Builder extensions.
 * Run: node scripts/test_builder_extensions.cjs
 *
 * TypeScript is already a dev dependency of the Vinext project. We transpile
 * ONLY pure model/validator modules into memory to test their runtime logic;
 * React, Cloudflare, and D1 are not needed for these specific cases.
 * This intentionally does NOT replace running `tsc --noEmit` or HTTP tests.
 */
// TypeScript 7 has no JS Compiler API; use the compatibility package when
// available, otherwise fall back to the current compiler on TypeScript <=6.
const ts = (() => {
  for (const name of ['@typescript/typescript6', 'typescript']) {
    try {
      const candidate=require(name);
      if (candidate.ModuleKind && candidate.transpileModule) return candidate;
    } catch { /* Try next option. */ }
  }
  throw new Error('Install @typescript/typescript6 as a dev dependency to run this regression script.');
})();
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
const sound=model.newBlock('timeline_annotation');
sound.groundingMode='sound';
sound.tiers=[{id:'events',name:'Sound events',kind:'interval',allowOverlap:true,labelMode:'text'}];
assert.equal(sound.groundingMode,'sound');
const vote=model.newBlock('candidate_vote');
vote.options=[{id:'AGREE',label:'Correct'},{id:'DISAGREE',label:'Needs changes'},{id:'UNSURE',label:'Unclear'}];
vote.allowCorrection=true;
assert.equal(model.publishLimit(vote),undefined,'Candidate voting is server-validated');
const voteDefinition={...defs,blocks:[vote]};
assert.deepEqual(answerCheck.validateAnswers(voteDefinition,{[vote.id]:{value:'AGREE'}},true),[]);
assert(answerCheck.validateAnswers(voteDefinition,{[vote.id]:{value:'DISAGREE'}},true)
  .some(x=>x.message.includes('correction')));
assert.deepEqual(answerCheck.validateAnswers(voteDefinition,
  {[vote.id]:{value:'DISAGREE',correctedText:'bird is audible'}},true),[]);
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
console.log('PASS: display-only blocks, conditional confirmation, candidate votes, Sound/Speech timelines.');
