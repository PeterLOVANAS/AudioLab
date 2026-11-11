/** Synthetic producer/consumer fixture; no source answers or real people. */
import type { WorkflowGraph, Staffing, SubmissionRef, ReviewDecision, AcceptedResult, VoteResult, BuilderReturn } from "../../lib/contracts/workflows";
const staffing: Staffing = { independentWorkers: 2, pool: { selection: { kind: "users", ids: ["alice", "bob"] }, eligibility: { projectId: "project", role: "labeller", expertise: ["sound"], minimumExperience: 0, excludeSubmitters: false } } };
const reviewer: Staffing = { independentWorkers: 1, pool: { selection: { kind: "users", ids: ["reviewer"] }, eligibility: { ...staffing.pool.eligibility, role: "reviewer", excludeSubmitters: true } } };
const fields = [{ id: "sound_presence", type: "boolean", required: true }, { id: "sound_category", type: "string", required: true }] as const;
export const graph: WorkflowGraph = {
 schemaVersion: 1, workflowId: "negation", nodes: [
 { id: "source", kind: "source", label: "Dataset", position: {x:0,y:0}, datasetId: "synthetic", outputs: [{id:"question",type:"string",required:true},{id:"choices",type:"string[]",required:true}] },
 { id: "annotate", kind: "annotation", label: "Negation", position:{x:100,y:0}, definition:{id:"negation-form",version:1},staffing,inputs:[],outputs:[...fields] },
 { id: "review", kind: "review", label: "Review", position:{x:200,y:0},upstreamNodeId:"annotate",selectedFields:fields.map(f=>f.id),staffing:reviewer,inputs:[...fields],outputs:[...fields],decisions:["approve","adjudicate","reject"] },
 { id: "ground", kind: "annotation", label: "Grounding", position:{x:300,y:0},definition:{id:"ground-form",version:1},staffing:{...staffing,independentWorkers:1,pool:{...staffing.pool,selection:{kind:"users",ids:["downstream"]}}},inputs:[fields[1]],outputs:[{id:"intervals",type:"intervals",required:true}] }
 ], edges:[
 {id:"e1",from:"source",to:"annotate",when:"ready",rework:false},
 {id:"e2",from:"annotate",to:"review",when:"submitted",rework:false},
 {id:"e3",from:"review",to:"ground",when:"accepted",rework:false},
 {id:"e4",from:"review",to:"annotate",when:"rejected",rework:true}
 ],bindings:[...fields.map(f=>({targetNodeId:"review",binding:{id:"review-"+f.id,source:{kind:"submission" as const,nodeId:"annotate",fieldId:f.id},targetFieldId:f.id,type:f.type,mode:"readonly" as const}})),{targetNodeId:"ground",binding:{id:"accepted-category",source:{kind:"accepted",nodeId:"review",fieldId:"sound_category"},targetFieldId:"sound_category",type:"string",mode:"readonly"}}]
};
export const submissions: SubmissionRef[] = ["alice","bob"].map((labellerId,i)=>({id:`revision-${i}`,assignmentId:`assignment-${i}`,labellerId,revision:1}));
export const accepted: AcceptedResult = {id:"accepted-1",fields:{sound_presence:true,sound_category:"dog"},provenance:{graph:{workflowId:"negation",version:1},attempt:{batchId:"batch",itemRunId:"item-1",nodeId:"review",attempt:1,stageRunId:"review-1"},submissions,reviewId:"review-job-1"}};
export const approval: ReviewDecision = {reviewJobId:"review-job-1",expectedRevision:0,pinnedSubmissions:submissions,kind:"approve",selectedSubmissionId:"revision-0",accepted};
export const rejection: ReviewDecision = {reviewJobId:"review-job-2",expectedRevision:0,pinnedSubmissions:submissions.map(s=>({...s,id:s.id+"-item2",assignmentId:s.assignmentId+"-item2"})),kind:"reject",feedback:"Category disagrees with the recording",reworkNodeId:"annotate"};
export const tie: VoteResult = {id:"vote-1",blockId:"candidate",attempt:accepted.provenance.attempt,distinctVoters:2,requiredVotes:2,submissions,state:"tie"};
export const builderReturn: BuilderReturn = {context:{workflowId:"negation",draftRevision:1,selectedNodeId:"annotate",returnToken:"opaque-context-token"},outcome:"published",definition:{id:"negation-form",version:1}};
// Compile-time consumer uses the same contract as the review producer.
export function groundingInput(result: AcceptedResult): unknown { return result.fields.sound_category; }
// @ts-expect-error Unpublished drafts cannot masquerade as a published version.
const invalidReturn: BuilderReturn = {context:builderReturn.context,outcome:"published",definition:{id:"draft"}};
void invalidReturn;
