"use client";
/**
 * The old Task Builder exposed the `workspace` object only implicitly. This
 * editor makes the saved preferences visible, but does NOT falsely claim that
 * toggling spectrogram/pitch/MFCC performs server-side acoustic computation.
 * The dedicated audio editor implements waveform/tier interaction first; the
 * other flags communicate intended research-workspace capabilities.
 */
import type { AudioWorkspaceConfig } from "@/lib/contracts/tasks";

const tools: Array<{key:keyof AudioWorkspaceConfig;label:string;help:string}>=[
  {key:"waveform",label:"Waveform",help:"Audio level over time, zoom, selection and playback."},
  {key:"spectrogram",label:"Spectrogram",help:"Time-frequency display (planned: not computed in this version)."},
  {key:"pitch",label:"Pitch / F0",help:"Pitch track (planned)."},
  {key:"formants",label:"Formants",help:"Formant track (planned)."},
  {key:"mfcc",label:"MFCC",help:"Mel cepstral coefficients (planned)."},
  {key:"allowTextGridImport",label:"TextGrid import",help:"Import and export Praat interval tiers using the grounding block."},
];
export default function WorkspaceSettings({value,onChange}:{
  value?:AudioWorkspaceConfig;onChange:(value:AudioWorkspaceConfig)=>void;
}){
  return <div className="tb-workspace-settings">
    <p className="tb-muted">These flags are saved in the Task Definition. A disabled or planned tool cannot be used as a real feature until its renderer is implemented.</p>
    <div className="tb-grid tb-wide">{tools.map(tool=><label key={tool.key} className="tb-tool-option">
      <input type="checkbox" checked={Boolean(value?.[tool.key])} onChange={e=>onChange({...value,[tool.key]:e.target.checked})}/>
      <span><strong>{tool.label}</strong><small>{tool.help}</small></span>
    </label>)}</div>
  </div>;
}
