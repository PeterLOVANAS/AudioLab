"use client";
/**
 * A builder preview needs real sound, but Task Definitions are reusable.
 *
 * AudioLab's Lesson 7 API persists one primary asset on a Task INSTANCE,
 * not on a reusable Task Definition. This component therefore chooses an
 * example asset for the PREVIEW ONLY, and never inserts asset IDs or URLs
 * into the Task Definition draft sent to POST/PUT /task-definitions.
 *
 * Ranking/comparison slots are shown with independent preview choices but
 * cannot be used for real multi-audio annotation yet: Lesson 7 persists only
 * one assetId per Task Instance. This is clearly labelled in the UI.
 */
import { useEffect, useMemo, useState } from "react";
import type { Dataset, AudioAsset } from "@/lib/contracts/datasets";
import type { Samples } from "@/components/workbench/BlockFields";

export default function AudioPreviewPicker({projectId,slots,onChange}:{
  projectId:string;
  slots:string[];
  onChange:(samples:Samples)=>void;
}) {
  const [datasets,setDatasets]=useState<Dataset[]>([]);
  const [datasetId,setDatasetId]=useState("");
  const [assets,setAssets]=useState<AudioAsset[]>([]);
  const [selected,setSelected]=useState("");
  const [bindings,setBindings]=useState<Record<string,string>>({});
  const [error,setError]=useState("");
  // Preserve a stable identity for slots even if two blocks use the same
  // human-readable slot name. Shared names refer to the same preview audio.
  const slotsKey=JSON.stringify(slots);
  // This key prevents an infinite effect when TaskBuilder creates a new array
  // containing the same slot names during a routine React render.
  const uniqueSlots=useMemo(()=>[...new Set((JSON.parse(slotsKey) as string[]).filter(Boolean))],[slotsKey]);
  useEffect(()=>{
    const controller=new AbortController();setDatasets([]);setDatasetId("");setAssets([]);setSelected("");setBindings({});setError("");
    if(!projectId)return;
    fetch(`/api/v1/datasets?projectId=${encodeURIComponent(projectId)}`,{signal:controller.signal})
      .then(async r=>{if(!r.ok)throw new Error(`Dataset HTTP ${r.status}`);return r.json() as Promise<{datasets:Dataset[]}>;})
      .then(data=>{if(!controller.signal.aborted){setDatasets(data.datasets);setDatasetId(data.datasets[0]?.id||"");}})
      .catch(err=>{if(!controller.signal.aborted)setError(String(err));});
    return()=>controller.abort();
  },[projectId]);
  useEffect(()=>{
    const controller=new AbortController();setAssets([]);setSelected("");setBindings({});
    if(!datasetId)return;
    fetch(`/api/v1/assets?datasetId=${encodeURIComponent(datasetId)}`,{signal:controller.signal})
      .then(async r=>{if(!r.ok)throw new Error(`Asset HTTP ${r.status}`);return r.json() as Promise<{assets:AudioAsset[]}>;})
      .then(data=>{if(!controller.signal.aborted){setAssets(data.assets);setSelected(data.assets[0]?.id||"");}})
      .catch(err=>{if(!controller.signal.aborted)setError(String(err));});
    return()=>controller.abort();
  },[datasetId]);
  useEffect(()=>{
    const toUrl=(id:string)=>id?`/api/v1/assets/${encodeURIComponent(id)}/audio`:undefined;
    const audio:Record<string,string>={};
    for(const slot of uniqueSlots){const url=toUrl(bindings[slot]||selected);if(url)audio[slot]=url;}
    onChange({primaryUrl:toUrl(selected),audio});
    // onChange is a state-setter from TaskBuilder. Do not depend on a changing
    // callback identity, or the effect could render infinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[selected,bindings,uniqueSlots]);
  return <section className="tb-panel tb-preview-source">
    <p className="tb-eyebrow">PREVIEW DATA / NOT SAVED IN TASK DEFINITION</p>
    <h3>Test using an existing audio asset</h3>
    <p className="tb-muted">Select a dataset and one MMAU WAV to hear how the real Labeller will experience this task.</p>
    <div className="tb-grid tb-wide">
      <label className="tb-field"><span>Dataset</span><select value={datasetId} onChange={e=>setDatasetId(e.target.value)}>
        <option value="">No dataset</option>{datasets.map(d=><option key={d.id} value={d.id}>{d.name} · {d.version}</option>)}
      </select></label>
      <label className="tb-field"><span>Primary recording</span><select value={selected} onChange={e=>setSelected(e.target.value)}>
        <option value="">No audio available</option>{assets.map(a=><option key={a.id} value={a.id}>{a.originalPath}</option>)}
      </select></label>
    </div>
    {uniqueSlots.length>0 && <details className="tb-detail"><summary>Map comparison/ranking slots to preview audio</summary>
      <p className="tb-muted">These selections affect preview only. Multi-audio Task Instance persistence is not implemented yet.</p>
      <div className="tb-grid tb-wide">{uniqueSlots.map(slot=><label className="tb-field" key={slot}><span>{slot}</span>
        <select value={bindings[slot]||selected} onChange={e=>setBindings(prev=>({...prev,[slot]:e.target.value}))}>
          <option value="">No recording</option>{assets.map(a=><option key={a.id} value={a.id}>{a.originalPath}</option>)}
        </select>
      </label>)}</div>
    </details>}
    {error && <p className="tb-notice bad" role="alert">{error}</p>}
  </section>;
}
