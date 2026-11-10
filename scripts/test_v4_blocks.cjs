/*
 * AudioLab 2.0 v4 — real validation logic regression tests (zero HTTP).
 * This test dynamically transpiles the source modules so it exercises
 * the repository's actual functions, not a separate handwritten mock.
 *
 * If the project runs TypeScript 7 (native toolchain), install
 * `@typescript/typescript6` for this legacy JS transpilation harness.
 */
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
let ts;
try{ts=require('@typescript/typescript6')}catch{
  try{ts=require('typescript')}catch{
    ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js');
  }
}
if(!ts.ModuleKind||!ts.transpileModule)throw new Error('Install @typescript/typescript6 for transpileModule.');
function load(file){
  const filename=path.resolve(__dirname,'..',file);
  const code=fs.readFileSync(filename,'utf8');
  const js=ts.transpileModule(code,{fileName:filename,compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX
  }}).outputText;
  const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  m.require=function(target){
    if(target.startsWith('.')&&target.endsWith('timeline-answers'))
      return load('lib/backend/validation/timeline-answers.ts');
    return Module.prototype.require.call(this,target);
  };
  m._compile(js,filename);return m.exports;
}
const {validateAnswers}=load('lib/backend/validation/annotation-answers.ts');
const {newBlock,checkDraft,blankDraft}=load('components/task-builder/model.ts');
function verify(ok,msg){if(!ok)throw new Error(msg)}
const common={name:'v4 tests',description:'',domain:'sound',instructions:'Listen carefully',
  policy:{requiredIndependentVotes:1,blindToOthers:true,requiresReview:false}};
function run(block,answer,context){
  return validateAnswers({...common,blocks:[block]},
    answer===undefined?{}:{[block.id]:answer},true,context);
}
const audioCtx={audioAssetCount:8,candidateIds:['candidate-1']};
const comparison={id:'compare',type:'audio_comparison',label:'Which sounds better?',required:true,
  numBatch:8,comparisonSize:2,stimulusSlots:['Audio A','Audio B'],
  options:[{id:'left',label:'Left'},{id:'right',label:'Right'}]};
verify(run(comparison,['left','right','left','right'],audioCtx).length===0,'8 WAV => 4 valid choices');
verify(run(comparison,['left'],audioCtx).length>0,'wrong comparison count should fail');
verify(run(comparison,['left','left','left','left'],{audioAssetCount:6}).length>0,'missing WAV should fail');
const ranking={id:'rank',type:'ranking',label:'Rank labels',required:true,rankingMode:'labels',
  rankLabels:[{id:'natural',label:'Natural'},{id:'clear',label:'Clear'}]};
verify(run(ranking,['clear','natural'],audioCtx).length===0,'valid attribute ranking');
verify(run(ranking,['clear','clear'],audioCtx).length>0,'duplicate rank rejected');
const choice={id:'presence',type:'single_choice',label:'Bird present?',required:true,
  options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],optionFollowUps:{no:[
    {id:'confirm',type:'boolean',label:'Fully listened',required:true,requiredValue:true},
    {id:'help',type:'callout',label:'Important',required:false,description:'Listen again'}
  ]}};
verify(run(choice,{selection:'no',children:{confirm:true}},audioCtx).length===0,'valid inline confirmation');
verify(run(choice,{selection:'no',children:{confirm:false}},audioCtx).length>0,'reject false');
verify(run(choice,{selection:'yes',children:{confirm:true}},audioCtx).length>0,'reject stale hidden child');
const batch={id:'clip',type:'text',label:'Describe',required:true,numBatch:3};
verify(run(batch,['one','two','three'],audioCtx).length===0,'3 repeated text answers');
verify(run(batch,['one','two'],audioCtx).length>0,'batch length mismatch');
verify(validateAnswers({...common,blocks:[batch]},{clip:['one',null,null]},false,audioCtx).length===0,'partial draft can omit unfinished panels');
verify(validateAnswers({...common,blocks:[comparison]},{compare:['left',null,null,null]},false,audioCtx).length===0,'partial comparison draft');
const vote={id:'vote',type:'candidate_vote',label:'Candidate valid?',required:true,
  options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],candidateSource:'curated'};
verify(run(vote,{value:'yes',candidateId:'candidate-1'},audioCtx).length===0,'curated candidate');
verify(run(vote,{value:'yes',candidateId:'reference-secret'},audioCtx).length>0,'unapproved candidate rejected');
const draft={...blankDraft(),name:'Batch check',instructions:'Listen',blocks:[comparison]};
verify(checkDraft(draft).length===0,'valid comparison definition');
console.log('PASS AudioLab v4: comparison batches, rankings, embedded follow-ups, text batches, curated candidate identity.');
