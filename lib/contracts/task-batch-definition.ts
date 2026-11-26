import type { PublishedDefinitionData } from "@/lib/contracts/task-instances";
/** Instance-local projection, never an edit of a published version. Flexible
 * team jobs pin this policy in immutable plan_json; older jobs keep their schema.
 * Per-audio blocks shrink for the final partial batch. A standalone Grounding
 * block expands to the actual slots and uses tabs, retaining answers per slot.
 */
export function taskBatchDefinition(definition:PublishedDefinitionData,slots:number):PublishedDefinitionData {
  if(!Number.isInteger(slots)||slots<1||slots>24)throw new Error("Invalid Task Instance audio count.");
  return {...definition,blocks:definition.blocks.map(block=>{
    const count=typeof block.numBatch==="number"?block.numBatch:(block.type==="audio_comparison"?2:1);
    if(block.type==="audio_comparison"){
      const per=typeof block.comparisonSize==="number"?block.comparisonSize:2;
      if(Math.min(count,slots)%per!==0)throw new Error(`Final batch has ${slots} recordings; audio comparison requires complete groups of ${per}. Choose another sample count.`);
    }
    if(block.type==="ranking"&&block.rankingMode!=="labels"&&Array.isArray(block.stimulusSlots)&&block.stimulusSlots.length>slots){
      if(slots<2)throw new Error("Audio ranking needs at least two recordings in the final batch. Choose another sample count.");
      return {...block,numBatch:Math.min(count,slots),stimulusSlots:block.stimulusSlots.slice(0,slots)};
    }
    return {...block,...(block.type==="timeline_annotation"&&count<=1&&slots>1?{numBatch:slots}:count>slots?{numBatch:slots}:{})};
  })};
}
/** Runtime-only renderer hint is added AFTER strict definition validation. */
export function markGroundingTabs(original:PublishedDefinitionData,resolved:PublishedDefinitionData):PublishedDefinitionData {
  return {...resolved,blocks:resolved.blocks.map(block=>original.blocks.some(source=>source.id===block.id&&source.type==="timeline_annotation")&&Number(block.numBatch)>1?{...block,audioNavigation:"tabs"}:block)};
}
