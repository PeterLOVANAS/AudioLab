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
  const speech=(block.groundingMode??"speech")==="speech";
  /**
   * A researcher adds ONE grounding block, then chooses Sound or Speech.
   * The waveform, plots, tier lanes, phonetic palette and timing table are
   * sections inside that same workbench, not separate survey questions.
   *
   * Switching modes changes only the draft configuration. We preserve any
   * custom tiers that make sense for the new mode by presenting editable
   * presets; existing published versions remain frozen by Lesson 6.
   */
  function chooseMode(mode:"sound"|"speech"){
    const defaultTiers:TimelineTier[]= mode==="speech" ? [
      {id:"words",name:"Words",kind:"interval",allowOverlap:true,labelMode:"text"},
      {id:"phones",name:"Phones",kind:"interval",allowOverlap:true,labelMode:"ipa",parentTierId:"words"},
    ] : [{id:"events",name:"Sound events",kind:"interval",allowOverlap:true,labelMode:"text"}];
    onChange({...block,groundingMode:mode,tiers:defaultTiers,
      aids:{spectrogram:true,pitch:mode==="speech",energy:mode==="speech",
        formants:false,mfcc:false}});
  }
  function aid(key:keyof NonNullable<Block["aids"]>,checked:boolean){
    onChange({...block,aids:{...block.aids,[key]:checked}});
  }
  function update(i:number, patch:Partial<TimelineTier>) {
    onChange({...block,tiers:tiers.map((tier,j)=>j===i?{...tier,...patch} as TimelineTier:tier)});
  }
  return <div className="tb-tier-config">
    <p className="tb-muted">Configure the ORIGINAL prototype workbench as one block. One time selection synchronizes the waveform, plots and all tiers.</p>
    <div className="tb-grid tb-wide">
      <label className="tb-field"><span>Research mode</span>
        <select value={block.groundingMode??"speech"} onChange={e=>chooseMode(e.target.value as "sound"|"speech")}>
          <option value="sound">Sound — event regions</option>
          <option value="speech">Speech — words and phones</option>
        </select>
      </label>
      <label className="tb-field"><span>Time precision (seconds)</span>
        <input type="number" min={0.00001} max={1} step={0.001}
          value={block.precisionSeconds??0.01}
          onChange={e=>onChange({...block,precisionSeconds:e.target.valueAsNumber})}/>
      </label>
      <label className="tb-field"><span>Lane layout</span>
        <select value={block.laneLayout??"overlap"}
          onChange={e=>onChange({...block,laneLayout:e.target.value as Block["laneLayout"]})}>
          <option value="overlap">Compact / overlapping lanes</option>
          <option value="separate">Separate named lanes</option>
        </select>
      </label>
    </div>
    <fieldset className="tb-tier-configuration">
      <legend>Acoustic and research aids</legend>
      <p className="tb-muted">These switches configure the original spectrogram/F0/MFCC panels, implemented by its audio worker. The worker runs locally in the browser.</p>
      <div className="tb-grid">
        {(["spectrogram","pitch","energy","formants","mfcc"] as const).map(key=><label className="tb-check" key={key}>
          <input type="checkbox" checked={!!block.aids?.[key]}
            onChange={e=>aid(key,e.target.checked)}/>{key==="pitch"?"Pitch (F0)":key==="mfcc"?"MFCC":key[0].toUpperCase()+key.slice(1)}
        </label>)}
      </div>
    </fieldset>
    <label className="tb-field"><span>Speaker labels (one per line)</span>
      <textarea rows={2} value={(block.speakers??["Speaker 1","Speaker 2"]).join("\n")}
        onChange={e=>onChange({...block,speakers:e.target.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)})}/>
    </label>
    {!speech&&<div className="tb-field">
      <span>Sound concept options</span>
      <p className="tb-muted">Each line is one label in the original sound-region editor. IDs remain stable when labels change.</p>
      {(block.soundConcepts??[]).map((o,i)=><div key={o.id} className="tb-option-edit">
        <span>{i+1}</span>
        <input aria-label={`Sound concept ${i+1}`} value={o.label}
          onChange={e=>onChange({...block,soundConcepts:(block.soundConcepts??[]).map(x=>x.id===o.id?{...x,label:e.target.value}:x)})}/>
        <button type="button" aria-label={`Remove sound concept ${i+1}`}
          onClick={()=>onChange({...block,soundConcepts:(block.soundConcepts??[]).filter(x=>x.id!==o.id)})}><Trash2 size={14}/></button>
      </div>)}
      <button className="tb-link" type="button" onClick={()=>onChange({...block,
        soundConcepts:[...(block.soundConcepts??[]),{id:crypto.randomUUID(),label:"New sound"}]})}>Add sound concept</button>
    </div>}

    {speech && <div className="tb-grid">
      <label className="tb-field"><span>Phonetic alphabet</span><select value={block.alphabet??"IPA"}
        onChange={e=>onChange({...block,alphabet:e.target.value as Block["alphabet"]})}>
        {(["IPA","SAMPA","X-SAMPA","ARPABET"] as const).map(a=><option key={a}>{a}</option>)}
      </select></label>
      <label className="tb-field"><span>Detail</span><select value={block.transcriptionLevel??"broad"}
        onChange={e=>onChange({...block,transcriptionLevel:e.target.value as Block["transcriptionLevel"]})}>
        <option value="phonemic">Phonemic</option><option value="broad">Broad</option><option value="narrow">Narrow</option>
      </select></label>
    </div>}
    {speech&&<label className="tb-field"><span>Optional phonetic symbol inventory (space-separated)</span>
      <input value={(block.phoneticSymbols??[]).join(" ")}
        placeholder="Leave empty for the prototype's full IPA inventory"
        onChange={e=>onChange({...block,phoneticSymbols:e.target.value.split(/\s+/).filter(Boolean)})}/>
    </label>}
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
