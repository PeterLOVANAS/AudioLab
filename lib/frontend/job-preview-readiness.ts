/** Visible preflight for the job form, not an authorization boundary.
 * The allocation API still validates eligibility, published versions and source
 * binding compatibility from its own records. Return every actionable blocker
 * instead of silently disabling the only preview button.
 */
export function jobPreviewProblems(input: {
  name:string;protocol:string;datasetId:string;workers:string[];keys:string[];
  sampleCount:number;seed:string;mode:"individual"|"voting";recordingsPerTask?:number;useEntireDataset?:boolean;
}):string[] {
  const problems:string[]=[];
  if(!input.name.trim())problems.push("Enter a job name.");
  if(!input.protocol)problems.push("Choose a published Task Definition / version.");
  if(!input.datasetId)problems.push("Choose a dataset.");
  if(!input.workers.length)problems.push("Select at least one labeller (or select a saved team).");
  if(input.workers.length>20)problems.push("Select at most 20 labellers.");
  if(!input.useEntireDataset&&!input.keys.length)problems.push("Select at least one dataset item.");
  if(input.keys.length>50)problems.push("Select at most 50 dataset items.");
  if(!Number.isInteger(input.sampleCount)||input.sampleCount<1||input.sampleCount>(input.useEntireDataset?1000:50))problems.push("Set the number of items to sample to a whole number within the selected dataset/sample limit.");
  else if(!input.useEntireDataset&&input.sampleCount>input.keys.length)problems.push(`Select at least ${input.sampleCount} items, or reduce the sample count to ${input.keys.length}.`);
  if(!input.seed.trim())problems.push("Enter a shuffle seed or click New random seed.");
  const size=input.recordingsPerTask??1;
  if(input.mode==="voting"&&Math.ceil(input.sampleCount/size)*input.workers.length>500)problems.push("Reduce the Voting panel or item count to at most 500 assignments.");
  return problems;
}
