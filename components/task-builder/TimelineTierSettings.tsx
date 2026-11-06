"use client";
/**
 * The Task Builder edits tier METADATA, not time annotations.
 *
 * A definition says what tiers exist (words, phones, sound events), whether
 * overlap is allowed, and which tier may be linked semantically to another.
 * Later, each Task Instance binds an audio recording, and each Labeller saves
 * intervals under the stable tier IDs defined here.
 *
 * IDs are intentionally never derived from tier names; renaming "Phones" to
 * "Phonemes" must NOT erase or reinterpret existing annotation values.
 */
import type { Block } from "./model";
import type { TimelineTier } from "@/lib/contracts/tasks";
import { Plus, Trash2 } from "lucide-react";
export default function TimelineTierSettings({block,onChange}:{
  block:Block;onChange:(block:Block)=>void;
}) {
  const tiers=block.tiers??[];
  function update(i:number, patch:Partial<TimelineTier>) {
    onChange({...block,tiers:tiers.map((tier,j)=>j===i?{...tier,...patch} as TimelineTier:tier)});
  }
  return <div className="tb-tier-config">
    <p className="tb-muted">Define interval tiers. Segments are created later in the Labeller workspace; parent links do not constrain timing.</p>
    <div className="tb-grid">
      <label className="tb-field"><span>Phonetic alphabet</span><select value={block.alphabet??"IPA"}
        onChange={e=>onChange({...block,alphabet:e.target.value as Block["alphabet"]})}>
        {(["IPA","SAMPA","X-SAMPA","ARPABET"] as const).map(a=><option key={a}>{a}</option>)}
      </select></label>
      <label className="tb-field"><span>Detail</span><select value={block.transcriptionLevel??"broad"}
        onChange={e=>onChange({...block,transcriptionLevel:e.target.value as Block["transcriptionLevel"]})}>
        <option value="phonemic">Phonemic</option><option value="broad">Broad</option><option value="narrow">Narrow</option>
      </select></label>
    </div>
    {tiers.map((tier,i)=><div className="tb-tier-configuration" key={tier.id}>
      <div className="tb-between"><strong>Tier {i+1}</strong>
        <button type="button" aria-label={`Remove tier ${tier.name}`} disabled={tiers.length<=1}
          onClick={()=>onChange({...block,tiers:tiers.filter(t=>t.id!==tier.id).map(t=>t.parentTierId===tier.id?{...t,parentTierId:undefined}:t)})}><Trash2 size={14}/></button>
      </div>
      <div className="tb-grid tb-wide">
        <label className="tb-field"><span>Name</span><input value={tier.name} maxLength={80} onChange={e=>update(i,{name:e.target.value})}/></label>
        <label className="tb-field"><span>Input type</span><select value={tier.labelMode} onChange={e=>update(i,{labelMode:e.target.value as TimelineTier["labelMode"]})}>
          <option value="text">Words or text</option><option value="ipa">Phonetic symbols</option>
          <option value="speaker_id">Speaker ID</option>
          {/* Categorical tier labels need a per-tier option editor; do not
              let new tasks select that mode until it is implemented. An
              existing published tier with that mode is still preserved. */}
          {tier.labelMode === "choice" && <option value="choice">Categorical (legacy)</option>}
        </select></label>
      </div>
      <div className="tb-grid tb-wide">
        <label className="tb-check"><input type="checkbox" checked={tier.kind==="interval"&&tier.allowOverlap}
          onChange={e=>update(i,{kind:"interval",allowOverlap:e.target.checked})}/> Allow overlapping intervals</label>
        <label className="tb-field"><span>Optional parent tier</span><select value={tier.parentTierId??""}
          onChange={e=>update(i,{parentTierId:e.target.value||undefined})}>
          <option value="">Independent tier (none)</option>
          {tiers.filter(t=>t.id!==tier.id).map(other=><option key={other.id} value={other.id}>{other.name}</option>)}
        </select></label>
      </div>
    </div>)}
    <button className="tb-link" type="button" disabled={tiers.length>=10} onClick={()=>{
      const id=crypto.randomUUID();onChange({...block,tiers:[...tiers,{id,name:`Tier ${tiers.length+1}`,labelMode:"text",kind:"interval",allowOverlap:true}]});
    }}><Plus size={14}/> Add tier</button>
  </div>;
}
