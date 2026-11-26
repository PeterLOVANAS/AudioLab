/** Number of ordered recordings one Task Instance needs. Blocks reuse this same
 * audio queue: three blocks of NUM_BATCH=2 need two recordings, not six.
 * Audio ranking may additionally name several explicit stimulus slots.
 */
export function requiredTaskRecordings(blocks: Array<{type:string;numBatch?:unknown;rankingMode?:unknown;stimulusSlots?:unknown}>):number {
  return Math.max(1,...blocks.map(block=>{
    const count=typeof block.numBatch==="number"?block.numBatch:(block.type==="audio_comparison"?2:1);
    return block.type==="ranking" && block.rankingMode!=="labels" && Array.isArray(block.stimulusSlots)
      ? Math.max(count,block.stimulusSlots.length):count;
  }));
}
/** Pack an already shuffled source selection into complete ordered batches.
 * A batch cannot contain two question items pointing to the same recording,
 * because task input snapshots and audio slots require distinct audio IDs.
 * Highest remaining asset frequency is filled first, avoiding greedy dead ends.
 * No selected item is discarded or duplicated; a final partial batch is explicit.
 */
export function packTaskBatches<T extends {key:string;assetId:string}>(items:T[],size:number):T[][] {
  if(!Number.isInteger(size)||size<1||size>24)throw new Error("A Task Instance supports 1–24 recordings.");
  if(!items.length)throw new Error("Select at least one source item.");
  if(new Set(items.map(item=>item.key)).size!==items.length)throw new Error("Duplicate source item identities in batch selection.");
  // Keep legacy singleton allocation order/hash exactly as before batching.
  if(size===1)return items.map(item=>[item]);
  const count=Math.ceil(items.length/size);
  const positions=new Map(items.map((item,index)=>[item.key,index]));
  const grouped=new Map<string,T[]>();
  for(const item of items)grouped.set(item.assetId,[...(grouped.get(item.assetId)??[]),item]);
  if([...grouped.values()].some(group=>group.length>count))throw new Error(`Cannot form ${count} batches of ${size} distinct recordings from this selection. Select fewer questions sharing one audio, or select more distinct recordings.`);
  const batches:T[][]=[];
  for(let index=0;index<count;index++){
    const groups=[...grouped.values()].filter(group=>group.length).sort((a,b)=>b.length-a.length||positions.get(a[0].key)!-positions.get(b[0].key)!);
    const target=Math.min(size,items.length-index*size);
    const batch=groups.slice(0,target).map(group=>group.shift()!);
    if(batch.length!==target)throw new Error("Not enough distinct recordings to complete this batch.");
    batches.push(batch.sort((a,b)=>positions.get(a.key)!-positions.get(b.key)!));
  }
  return batches;
}
