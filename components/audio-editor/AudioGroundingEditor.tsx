"use client";
/**
 * AudioLab 2.0 — Timeline grounding block, adapted from the ideas of
 * prototype/components/research/player.tsx and editor.tsx.
 *
 * Why not import the original AudioPlayer directly?
 * That component depends on the prototype's Task, coverage and answer shapes.
 * This implementation instead takes a standalone published block config,
 * one audio URL, one answer value and one onChange callback. The Task Builder
 * preview and Labeller Workspace can use this EXACT SAME component.
 *
 * Canonical answer format:
 * { tiers: { words: [{id,start,end,text,speaker?}],
 *            phones: [{id,start,end,text,speaker?,parentId?}] } }
 *
 * Time coordinates are seconds, not pixel positions. React state in this
 * component describes only the viewport (zoom/scroll/selection). The actual
 * segments are controlled by the caller, permitting reliable draft saving.
 *
 * Implemented here: decoded waveform, zoom and horizontal scroll, playback,
 * drag selection, interval creation/edit/delete, optional word linking,
 * speaker-separated summaries, IPA/ARPABET palette, TextGrid import/export.
 * Spectrogram, MFCC, and pitch extraction remain separate future tools.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { Download, FileUp, Minus, Plus, ZoomIn, ZoomOut, Maximize2, Minimize2, RotateCcw, Play, Pause } from "lucide-react";
import { symbolGroups, phoneticSummary } from "@/lib/audio/phonetics";
import { parseTextGrid, readAnnotationFile, writeTextGrid } from "@/lib/audio/textgrid";
import { timelineLanes } from "@/lib/audio/timeline";
import { commitSegment } from "@/lib/audio/segments";
import type { Block } from "@/components/task-builder/model";

export type GroundingSegment = {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  parentId?: string | null;
};
export type GroundingAnswer = { tiers: Record<string, GroundingSegment[]> };

type Tier = NonNullable<Block["tiers"]>[number];
const empty = (): GroundingAnswer => ({ tiers: {} });
const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function validSegment(s: GroundingSegment, duration: number) {
  return numeric(s.start) && numeric(s.end) && s.start >= 0 &&
    s.end > s.start && s.end <= duration + 0.001 && Boolean(s.text.trim());
}

/**
 * Waveform data is deliberately NON-persistent. It is derived from the URL
 * once and discarded when the selected preview recording changes. Each peak
 * is the maximum absolute amplitude for a group of decoded PCM samples.
 * This is fast enough for a preview, unlike plotting every sample of a long WAV.
 */
function useWaveform(url?: string) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setPeaks(null); setError("");
    if (!url) return;
    const abort = new AbortController();
    let active = true;
    let context: AudioContext | undefined;
    (async () => {
      try {
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok) throw new Error(`Audio HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        if (!active) return;
        // Decoding checks the ACTUAL waveform, not the server's sample-rate metadata.
        context = new AudioContext();
        const buffer = await context.decodeAudioData(bytes.slice(0));
        if (!active) return;
        const points = 2400;
        const values = new Float32Array(points);
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
        for (let i = 0; i < points; i++) {
          const start = Math.floor((i / points) * buffer.length);
          const end = Math.min(buffer.length, Math.max(start + 1, Math.floor(((i + 1) / points) * buffer.length)));
          let peak = 0;
          // Very long recordings still get bounded computation (sampling a window).
          const stride = Math.max(1, Math.floor((end - start) / 32));
          for (const channel of channels) for (let n = start; n < end; n += stride)
            peak = Math.max(peak, Math.abs(channel[n] ?? 0));
          values[i] = peak;
        }
        setPeaks(values);
      } catch (cause) {
        if (!abort.signal.aborted && active) setError(cause instanceof Error ? cause.message : "Unable to decode WAV");
      } finally {
        // Closing the AudioContext releases its decoder/device resources.
        if (context) void context.close().catch(() => {});
      }
    })();
    return () => { active = false; abort.abort(); if (context) void context.close().catch(() => {}); };
  }, [url]);
  return { peaks, error };
}

// After
function Waveform({ url, duration, currentTime, viewStart, viewLength, selection, height: waveformHeight = 112, onSelect, onSeek }:  {
  url?: string; duration: number; currentTime: number;
  viewStart: number; viewLength: number; selection: [number, number] | null; height?: number;
  onSelect: (range: [number, number]) => void; onSeek: (seconds: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragStart = useRef<number | null>(null);
  const { peaks, error } = useWaveform(url);
  // Double-click produces MouseEvent whereas dragging produces PointerEvent.
  // Both expose clientX/currentTarget, which are the only fields needed
  // for converting from screen pixels to seconds.
  const timeAt = useCallback((event: ReactMouseEvent<HTMLCanvasElement> | ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    return round(clamp(viewStart + fraction * viewLength, 0, duration));
  }, [duration, viewLength, viewStart]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const paint = () => {
      const rect = element.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      element.width = Math.max(300, Math.round(rect.width * scale));
      element.height = Math.round(waveformHeight * scale);
      const ctx = element.getContext("2d");
      if (!ctx) return;
      const width = element.width; const height = element.height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#eaf0f5"; ctx.fillRect(0, 0, width, height);
      // Grid marks are real seconds; they follow the zoomed viewport.
      const tick = Math.max(0.1, Math.pow(10, Math.floor(Math.log10(viewLength / 8))));
      ctx.strokeStyle = "#cbd6e1"; ctx.lineWidth = scale;
      for (let second = Math.ceil(viewStart / tick) * tick; second < viewStart + viewLength; second += tick) {
        const x = ((second - viewStart) / viewLength) * width;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
      if (selection) {
        const left = ((selection[0] - viewStart) / viewLength) * width;
        const right = ((selection[1] - viewStart) / viewLength) * width;
        ctx.fillStyle = "#7973d930";
        ctx.fillRect(left, 0, Math.max(0, right - left), height);
      }
      if (peaks) {
        ctx.strokeStyle = "#405f83"; ctx.lineWidth = Math.max(1, scale);
        const center = height / 2;
        for (let pixel = 0; pixel < width; pixel += Math.max(1, Math.floor(scale * 1.5))) {
          const second = viewStart + (pixel / width) * viewLength;
          const peakIndex = Math.min(peaks.length - 1, Math.floor((second / Math.max(duration, 0.001)) * peaks.length));
          const amplitude = peaks[Math.max(0, peakIndex)] * (center - 5 * scale);
          ctx.beginPath(); ctx.moveTo(pixel, center - amplitude); ctx.lineTo(pixel, center + amplitude); ctx.stroke();
        }
      } else {
        ctx.fillStyle = "#627b95"; ctx.font = `${12 * scale}px sans-serif`;
        ctx.fillText(error || "Waveform loads when a real audio asset is selected", 16 * scale, height / 2);
      }
      if (currentTime >= viewStart && currentTime <= viewStart + viewLength) {
        const x = ((currentTime - viewStart) / viewLength) * width;
        ctx.strokeStyle = "#b45153"; ctx.lineWidth = 2 * scale;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
    };
    paint();
    const ro = new ResizeObserver(paint); ro.observe(element);
    return () => ro.disconnect();
  }, [peaks, error, duration, currentTime, viewStart, viewLength, selection, waveformHeight]);
  return <canvas
    ref={canvas}
    className="tb-wave"
    style={{ height: waveformHeight }}
    role="img"
    aria-label="Audio waveform. Drag to select time range; double-click to seek"
    onDoubleClick={e => onSeek(timeAt(e))}
    onPointerDown={e => {
      if (!duration) return;
      dragStart.current = timeAt(e);
      e.currentTarget.setPointerCapture(e.pointerId);
      onSelect([dragStart.current, dragStart.current]);
    }}
    onPointerMove={e => {
      if (dragStart.current === null) return;
      const pos = timeAt(e);
      onSelect([Math.min(pos, dragStart.current), Math.max(pos, dragStart.current)]);
    }}
    onPointerUp={e => {
      if (dragStart.current === null) return;
      const pos = timeAt(e);
      const from = dragStart.current;
      dragStart.current = null;
      onSelect([Math.min(from, pos), Math.max(from, pos)]);
    }}
    onPointerCancel={() => { dragStart.current = null; }} />;
}

/**
 * Visual speaker/overlap lanes come from the original prototype's
 * `timelineLanes()`; this avoids overwriting simultaneous speakers. Segment
 * coordinates are normalized to the VISIBLE time range only for rendering.
 * Nothing changes in the stored answer when the viewport scrolls or zooms.
 */
function TierTracks({ tier, segments, viewStart, viewLength, selectedId, onChoose }: {
  tier: Tier; segments: GroundingSegment[]; viewStart: number; viewLength: number;
  selectedId: string; onChoose: (id: string) => void;
}) {
  const lanes = timelineLanes(segments, false, true) as {label:string;items:GroundingSegment[]}[];
  return <div className="tb-tier">
    <div className="tb-tier-heading"><strong>{tier.name}</strong><span>{segments.length} intervals</span></div>
    {(lanes.length ? lanes : [{label:"Empty",items:[]}]).map((lane, index) => <div key={`${lane.label}-${index}`} className="tb-tier-lane">
      <small>{lane.label}</small><div className="tb-tier-track">
        {lane.items.filter(s=>s.end>=viewStart && s.start<=viewStart+viewLength).map(s => {
          const left = clamp(((s.start-viewStart)/viewLength)*100,0,100);
          const right = clamp(((s.end-viewStart)/viewLength)*100,0,100);
          return <button key={s.id} type="button" title={`${s.text} ${s.start}–${s.end} s`} className={`tb-segment${selectedId===s.id?" chosen":""}`}
            style={{left:`${left}%`,width:`${Math.max(0.7,right-left)}%`}} onClick={()=>onChoose(s.id)}>{s.text}</button>;
        })}
      </div></div>) }
  </div>;
}

export default function AudioGroundingEditor({ block, audioUrl, value, onChange, readOnly=false }: {
  block: Block; audioUrl?: string; value?: GroundingAnswer;
  onChange: (value: GroundingAnswer) => void; readOnly?: boolean;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const textInput = useRef<HTMLInputElement>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [viewStart, setViewStart] = useState(0);
  const [viewLength, setViewLength] = useState(10);
  const [followPlayback, setFollowPlayback] = useState(false);
  // These presentation-only settings replicate the PROTOTYPE player's
  // layout settings and focus mode. None is stored in the annotation answer.
  const [focus, setFocus] = useState(false);
  const [waveHeight, setWaveHeight] = useState(112);
  const [tierHeight, setTierHeight] = useState(200);
  const [showTimingTable, setShowTimingTable] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState<[number,number] | null>(null);
  const [tierId, setTierId] = useState(block.tiers?.[0]?.id || "words");
  const [selectedId, setSelectedId] = useState("");
  const [speaker, setSpeaker] = useState("Speaker 1");
  const [label, setLabel] = useState("");
  const [parentId, setParentId] = useState("");
  const [linkBoundaries, setLinkBoundaries] = useState(false);
  const [notice, setNotice] = useState("");
  const tiers = useMemo(() => block.tiers ?? [], [block.tiers]);
  /**
   * The original prototype offers a focus mode that fills the viewport.
   * Disable background scrolling while focused; always restore the prior
   * value on exit/unmount to avoid leaking side effects into Task Builder.
   * Esc exits only when the user is NOT typing inside an editable control.
   */
  useEffect(() => {
    if (!focus) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onEscape = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape" && !target?.closest("input, textarea, select, [contenteditable='true']")) setFocus(false);
    };
    window.addEventListener("keydown", onEscape);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", onEscape); };
  }, [focus]);
  // Reset playback/viewport state when a DIFFERENT dataset asset is selected.
  // The annotation value itself belongs to the parent, and is not cleared here.
  useEffect(() => { setDuration(0); setTime(0); setPlaying(false); setViewStart(0); setViewLength(10); setSelection(null); }, [audioUrl]);
  const answer: GroundingAnswer = value && value.tiers ? value : empty();
  const current = tiers.find(t => t.id === tierId) ?? tiers[0];
  const currentSegments = current ? (answer.tiers[current.id] ?? []) : [];
  const chosen = currentSegments.find(s => s.id === selectedId);
  const maxStart = Math.max(0, duration - viewLength);
  function updateTier(id: string, items: GroundingSegment[]) {
    // Replacing the whole controlled value is intentional: React state belongs
    // to the parent, allowing future autosave and undo/redo integration.
    onChange({ tiers: { ...answer.tiers, [id]: items } });
  }
  function choose(id: string) {
    const segment = currentSegments.find(row => row.id === id);
    if (!segment) return;
    setSelectedId(id); setLabel(segment.text); setSpeaker(segment.speaker || "Speaker 1");
    setParentId(segment.parentId || ""); setSelection([segment.start, segment.end]);
  }
  function addOrEdit() {
    if (!current || readOnly) return;
    const bounds = selection;
    if (!bounds || bounds[1] <= bounds[0] || !label.trim()) {
      setNotice("Drag a nonempty selection in the waveform and enter a label."); return;
    }
    if (duration && bounds[1] > duration + 0.001) { setNotice("Segment exceeds audio duration."); return; }
    const segment: GroundingSegment = {
      id: chosen?.id ?? crypto.randomUUID(), start: round(bounds[0]), end: round(bounds[1]),
      text: label.trim(), speaker, ...(current.parentTierId ? {parentId: parentId || null} : {}),
    };
    if (!validSegment(segment, duration || 86400)) { setNotice("Invalid times or empty label."); return; }
    try {
      const updated = commitSegment(currentSegments as unknown[], segment, linkBoundaries) as GroundingSegment[];
      if (current.kind === "interval" && !current.allowOverlap) {
        const sorted = [...updated].sort((a,b)=>a.start-b.start || a.end-b.end);
        if (sorted.some((s,i)=>i>0&&s.start<sorted[i-1].end-1e-7)) {
          setNotice("This tier does not allow overlapping intervals."); return;
        }
      }
      updateTier(current.id, updated);
      setSelectedId(segment.id); setNotice("Segment updated in preview. Use the Labeller Save Draft action to persist it.");
    } catch (err) { setNotice(err instanceof Error ? err.message : "Failed to edit interval"); }
  }
  function remove() {
    if (!current || !chosen || readOnly) return;
    // Update the parent tier and any dependent child links in ONE controlled
    // state write, so no quick React render can leave dangling parent IDs.
    const next: GroundingAnswer = {tiers:{...answer.tiers,[current.id]:currentSegments.filter(s=>s.id!==chosen.id)}};
    for (const tier of tiers.filter(t=>t.parentTierId===current.id))
      next.tiers[tier.id] = (answer.tiers[tier.id]??[]).map(s=>s.parentId===chosen.id?{...s,parentId:null}:s);
    onChange(next);
    setSelectedId(""); setLabel(""); setNotice("Segment removed.");
  }
  const seek = (sec: number) => { if (audio.current) audio.current.currentTime=sec; setTime(sec); };
  function zoom(factor:number) {
    if (!duration) return;
    const length = clamp(viewLength/factor, Math.min(duration,.25), duration);
    setViewLength(length);
    setViewStart(clamp(time-length/2,0,Math.max(0,duration-length)));
  }
  function togglePlayback() {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setNotice("Audio could not start; check browser playback permissions."));
    else element.pause();
  }
  /** Zoom to a selection, preserving physical time coordinates in seconds. */
  function zoomToSelection() {
    if (!selection || selection[1] <= selection[0] || !duration) return;
    const padding = Math.max(0.05, (selection[1] - selection[0]) * 0.15);
    const start = clamp(selection[0] - padding, 0, duration);
    const end = clamp(selection[1] + padding, start, duration);
    setViewStart(start);
    setViewLength(Math.max(0.001, end - start));
  }
  function resetViewport() { setViewStart(0); setViewLength(duration || 10); }
  /**
   * Directly edit a saved interval in the timing table, as in the original
   * phonetics workspace. The parent still owns the authoritative answer;
   * editing here never saves to D1 without the Labeller Save Draft action.
   * A changed word label does not rewrite phone labels or parent IDs.
   */
  function updateTimingRow(tierIdToUpdate: string, segmentId: string, patch: Partial<GroundingSegment>) {
    if (readOnly) return;
    const originals = answer.tiers[tierIdToUpdate] ?? [];
    const next = originals.map(row => row.id === segmentId ? { ...row, ...patch } : row);
    updateTier(tierIdToUpdate, next);
    if (tierIdToUpdate === tierId && selectedId === segmentId) {
      const edited = next.find(row => row.id === segmentId);
      if (edited) {
        setSelection([edited.start, edited.end]);
        setLabel(edited.text);
        setSpeaker(edited.speaker || "Speaker 1");
      }
    }
  }
  function insertSymbol(symbol:string) {
    const input=textInput.current;
    const start=input?.selectionStart??label.length;
    const end=input?.selectionEnd??start;
    setLabel(label.slice(0,start)+symbol+label.slice(end));
    requestAnimationFrame(()=> { input?.focus(); input?.setSelectionRange(start+symbol.length,start+symbol.length); });
  }
  const phoneticTier = tiers.find(t => t.labelMode === "ipa");
  const wordTier = tiers.find(t => t.id === "words") ?? tiers.find(t=>t.labelMode === "text");
  const words=wordTier ? answer.tiers[wordTier.id]??[] : [];
  const phones=phoneticTier ? answer.tiers[phoneticTier.id]??[] : [];
  const phoneticConfig={alphabet:block.alphabet??"IPA",level:block.transcriptionLevel??"broad",symbols:[] as string[]};
  function exportGrid() {
    if (!duration || !tiers.length) { setNotice("Select a valid recording before exporting."); return; }
    try {
      const groups=tiers.flatMap(t=> (timelineLanes(answer.tiers[t.id]??[],true,true) as {label:string;items:GroundingSegment[]}[])
        .map(l=>({name:`${t.name} / ${l.label}`,items:l.items})));
      // TextGrid cannot represent overlapping intervals within one IntervalTier;
      // each packed lane is exported as its own tier, preserving time bounds.
      const content=writeTextGrid(groups,duration);
      const url=URL.createObjectURL(new Blob([content],{type:"text/plain;charset=utf-8"}));
      const link=document.createElement("a");link.href=url;link.download="audiolab-alignment.TextGrid";
      link.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
      setNotice("TextGrid exported; JSON revisions retain parent IDs and metadata.");
    } catch(e) {setNotice(e instanceof Error?e.message:"Unable to export TextGrid");}
  }
  async function importGrid(file?:File) {
    if (!file || !tiers.length || !duration) {setNotice("Choose a recording and a TextGrid first.");return;}
    try {
      const grid=parseTextGrid(await readAnnotationFile(file));
      if (grid.end>duration+0.05) throw new Error("TextGrid exceeds the current audio duration.");
      const next: GroundingAnswer={tiers:{...answer.tiers}};
      // Prefer exact names, then a prefix match. Speakers/overlap lane suffixes
      // are mapped back to a base tier. This deliberately never imports points.
      for(const tier of tiers) {
        const matching=grid.tiers.filter(t=>t.type==="IntervalTier" && (t.name===tier.name||t.name.startsWith(tier.name+" / ")));
        next.tiers[tier.id]=matching.flatMap(t=>t.items.filter(item=>item.text.trim()).map(item=>({
          id:crypto.randomUUID(), start:round(item.start),end:round(item.end),text:item.text,
          speaker:t.name.includes(" / ")?t.name.split(" / ").slice(1).join(" / "):"Speaker 1",
        })));
      }
      if(!window.confirm("Replace the timeline intervals currently shown in this preview with the imported TextGrid?")) return;
      onChange(next);setNotice("TextGrid imported into matching tiers. Check speaker labels and parent links.");
    } catch(e){setNotice(e instanceof Error?e.message:"TextGrid import failed");}
  }
  return <div className={`tb-grounding tb-phonetic-workbench${focus ? " tb-grounding-focus" : ""}`} data-grounding-block={block.id}>
    <div className="tb-bench-header">
      <div className="tb-bench-identity">
        <strong>AudioLab · {block.label || "Audio grounding"}</strong>
        <small>Independent word and phone tiers · second-based timing · speaker lanes</small>
      </div>
      <div className="tb-bench-header-actions">
        <span className="tb-bench-revision">Preview · no D1 write</span>
        <button type="button" className="tb-bench-focus-toggle" onClick={() => setFocus(v => !v)} aria-label={focus ? "Exit focus mode" : "Focus on audio timeline"}>
          {focus ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}
          {focus ? "Exit focus" : "Focus mode"}
        </button>
      </div>
    </div>
    <div className="tb-ground-toolbar">
      <strong>Timeline controls</strong>
      <button type="button" disabled={!audioUrl} onClick={togglePlayback} title="Play or pause">{playing ? <Pause size={15}/> : <Play size={15}/>}</button>
      <span>{time.toFixed(3)} / {duration.toFixed(3)} s</span>
      <button type="button" title="Zoom in" disabled={!duration} onClick={()=>zoom(1.8)}><ZoomIn size={15}/></button>
      <button type="button" title="Zoom out" disabled={!duration} onClick={()=>zoom(1/1.8)}><ZoomOut size={15}/></button>
      <button type="button" disabled={!duration} onClick={resetViewport} title="Show complete recording"><RotateCcw size={14}/> Fit recording</button>
      <button type="button" disabled={!selection || selection[1]<=selection[0]} onClick={zoomToSelection}>Zoom selection</button>
      <button type="button" disabled={!selection || selection[1]<=selection[0]} onClick={()=>{
        if(!audio.current || !selection) return;
        audio.current.currentTime=selection[0];setTime(selection[0]);void audio.current.play();
      }}>Play selection</button>
      <label className="tb-follow"><input type="checkbox" checked={followPlayback} onChange={e=>setFollowPlayback(e.target.checked)}/> Follow</label>
    </div>
    <details className="tb-layout-settings"><summary>Workbench layout · waveform and tier heights</summary>
      <div className="tb-layout-controls">
        <label>Waveform height <input type="range" min={65} max={270} step={5} value={waveHeight} onChange={e=>setWaveHeight(Number(e.target.value))}/><span>{waveHeight}px</span></label>
        <label>Tier viewport height <input type="range" min={110} max={440} step={10} value={tierHeight} onChange={e=>setTierHeight(Number(e.target.value))}/><span>{tierHeight}px</span></label>
        <label><input type="checkbox" checked={showTimingTable} onChange={e=>setShowTimingTable(e.target.checked)}/> Detailed word/phone timing table</label>
      </div>
    </details>
    <audio controls ref={audio} src={audioUrl} preload="metadata" className="tb-ground-audio"
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onLoadedMetadata={e=>{
        const d=e.currentTarget.duration;
        if(Number.isFinite(d) && d>0) {setDuration(d);setViewLength(Math.min(d,10));setViewStart(0);}
      }} onTimeUpdate={e=>{
        const t=e.currentTarget.currentTime;
        setTime(t);
        if(selection&&selection[1]>selection[0]&&t>=selection[1]&&t<selection[1]+.2)e.currentTarget.pause();
        if(followPlayback && t>viewStart+viewLength*.9) setViewStart(clamp(t-viewLength*.15,0,maxStart));
      }} onError={()=>setNotice("Audio cannot be played. Check that this asset exists in local R2.")}/>
    {!audioUrl && <p className="tb-inset">Choose a real dataset audio asset in the preview selector. The waveform, phone editing and playback will then use that recording.</p>}
    <div className="tb-timeline-ruler" aria-label="Visible time range">
      <b>Waveform</b><span>{viewStart.toFixed(3)} s</span><span>{(viewStart + viewLength / 2).toFixed(3)} s</span><span>{Math.min(duration || viewStart+viewLength,viewStart + viewLength).toFixed(3)} s</span>
    </div>
    <Waveform url={audioUrl} duration={duration} currentTime={time} viewStart={viewStart} viewLength={viewLength}
      height={waveHeight} selection={selection} onSelect={setSelection} onSeek={seek}/>
    <label className="tb-scroll-label">Scroll along recording
      <input aria-label="Scroll visible audio window" type="range" min={0} max={Math.max(0,duration-viewLength)}
        step={0.01} value={Math.min(viewStart,Math.max(0,duration-viewLength))}
        onChange={e=>setViewStart(Number(e.target.value))} disabled={!duration}/>
    </label>
    <div className="tb-tier-tabs">{tiers.map(t=><button key={t.id} type="button"
      className={tierId===t.id?"active":""} onClick={()=>{setTierId(t.id);setSelectedId("");setLabel("");setParentId("");}}>{t.name} ({(answer.tiers[t.id]??[]).length})</button>)}</div>
    <div className="tb-tiers-viewport" style={{maxHeight:tierHeight}}>
    {tiers.map(t=><TierTracks key={t.id} tier={t} segments={answer.tiers[t.id]??[]} viewStart={viewStart} viewLength={viewLength}
      selectedId={tierId===t.id?selectedId:""} onChoose={id=>{setTierId(t.id);
        const item=(answer.tiers[t.id]??[]).find(s=>s.id===id);
        if(item){setSelectedId(id);setLabel(item.text);setSpeaker(item.speaker||"Speaker 1");
          setParentId(item.parentId||"");setSelection([item.start,item.end]);}
      }}/>) }
    </div>
    <div className="tb-bench-status">
      <span>Cursor {time.toFixed(3)} s</span>
      <span>{selection && selection[1] > selection[0] ? `Selection ${selection[0].toFixed(3)}–${selection[1].toFixed(3)} s (${(selection[1]-selection[0]).toFixed(3)} s)` : "Drag the waveform to select a region"}</span>
      <span>{tiers.reduce((sum,t) => sum + (answer.tiers[t.id]??[]).length, 0)} labelled intervals</span>
    </div>
    <div className="tb-ground-edit">
      <h4>{chosen ? `Edit ${current?.name??"interval"}` : `New ${current?.name??"interval"}`}</h4>
      <p className="tb-inset">Drag on waveform to select a time interval. Click a labelled interval to edit it.</p>
      <div className="tb-ground-form">
        <label>Start (s)<input type="number" min={0} max={duration} step="0.001" value={selection?.[0]??""}
          onChange={e=>setSelection([round(Number(e.target.value)),selection?.[1]??0])}/></label>
        <label>End (s)<input type="number" min={0} max={duration} step="0.001" value={selection?.[1]??""}
          onChange={e=>setSelection([selection?.[0]??0,round(Number(e.target.value))])}/></label>
        <label>Speaker<input value={speaker} onChange={e=>setSpeaker(e.target.value)} maxLength={100}/></label>
        <label>Label<input ref={textInput} value={label} onChange={e=>setLabel(e.target.value)} maxLength={2000}
          placeholder={current?.labelMode==="ipa"?"e.g. ʃ / ə / tʰ":"Enter word or sound label"}/></label>
        {current?.parentTierId && <label>Optional parent word<select value={parentId} onChange={e=>setParentId(e.target.value)}>
          <option value="">No word link</option>
          {(answer.tiers[current.parentTierId]??[]).map(s=><option value={s.id} key={s.id}>{s.text} ({s.start}–{s.end} s)</option>)}
        </select></label>}
      </div>
      {current?.labelMode==="ipa" && <details className="tb-ipa-palette"><summary>{phoneticConfig.alphabet} symbols · {phoneticConfig.level}</summary>
        {Object.entries(symbolGroups(phoneticConfig)).map(([group,symbols])=><div key={group}>
          <small>{group}</small><div>{symbols.map((symbol:string)=><button key={symbol} type="button" title={`Insert ${symbol}`}
            onPointerDown={e=>e.preventDefault()} onClick={()=>insertSymbol(symbol)}>{/^[\u0300-\u036f]/.test(symbol)?"◌"+symbol:symbol}</button>)}</div></div>)}
      </details>}
      <label className="tb-follow"><input type="checkbox" checked={linkBoundaries} onChange={e=>setLinkBoundaries(e.target.checked)}/> Move adjacent linked boundaries (same tier)</label>
      <div className="tb-ground-actions">
        <button disabled={readOnly || !selection || !label.trim()} type="button" onClick={addOrEdit}><Plus size={14}/>{chosen?"Save segment":"Add segment"}</button>
        {chosen && <><button type="button" onClick={()=>{setSelectedId("");setLabel("");setParentId("");}}>New interval</button>
          <button disabled={readOnly} type="button" onClick={remove}><Minus size={14}/> Delete</button></>}
      </div>
    </div>
    {showTimingTable && <section className="tb-timing-section" aria-label="Word and phone alignment tables">
      <div className="tb-timing-head"><h4>Transcriptions from saved segments</h4><p>Inspect and edit timed labels directly, as in the original phonetics workbench. These are local preview edits until an assignment is saved.</p></div>
      {tiers.map(tier => {
        const rows = [...(answer.tiers[tier.id]??[])].sort((a,b) => a.start - b.start || a.end-b.end);
        return <div className="tb-timing-tier" key={tier.id}>
          <h5>{tier.name} <span>{rows.length} intervals</span></h5>
          <div className="tb-timing-scroll"><table className="tb-timing-table">
            <thead><tr><th>{tier.labelMode === "ipa" ? "Phone symbol" : "Word / label"}</th><th>Speaker</th><th>Start (s)</th><th>End (s)</th>{tier.parentTierId && <th>Word link</th>}<th/></tr></thead>
            <tbody>{rows.map(row => <tr key={row.id}>
              <td><input aria-label={`${tier.name} label`} disabled={readOnly} value={row.text} onChange={e => updateTimingRow(tier.id,row.id,{text:e.target.value})}/></td>
              <td><input aria-label="Speaker" disabled={readOnly} value={row.speaker || ""} onChange={e => updateTimingRow(tier.id,row.id,{speaker:e.target.value})}/></td>
              <td><input aria-label="Start time" type="number" step="0.001" min="0" disabled={readOnly} value={row.start} onChange={e => updateTimingRow(tier.id,row.id,{start:Number(e.target.value)})}/></td>
              <td><input aria-label="End time" type="number" step="0.001" min="0" disabled={readOnly} value={row.end} onChange={e => updateTimingRow(tier.id,row.id,{end:Number(e.target.value)})}/></td>
              {tier.parentTierId && <td><select aria-label="Parent word" disabled={readOnly} value={row.parentId || ""} onChange={e => updateTimingRow(tier.id,row.id,{parentId:e.target.value || null})}>
                <option value="">Unlinked</option>{(answer.tiers[tier.parentTierId]??[]).map(word => <option key={word.id} value={word.id}>{word.text}</option>)}
              </select></td>}
              <td><button type="button" onClick={() => {setTierId(tier.id);setSelectedId(row.id);setLabel(row.text);setSpeaker(row.speaker || "Speaker 1");setParentId(row.parentId || "");setSelection([row.start,row.end]);}}>Select</button></td>
            </tr>)}</tbody>
          </table></div>
          {rows.length===0 && <small>No saved {tier.name.toLowerCase()} intervals yet. Select a waveform range and use Add segment.</small>}
        </div>;
      })}
    </section>}
    <div className="tb-summary-grid">
      <div><strong>Current words</strong><p>{words.length ? [...words].sort((a,b)=>a.start-b.start).map(s=>s.text).join(" "):"No word labels yet."}</p></div>
      <div><strong>Current phones</strong><p>{phones.length ? phoneticSummary(phones,phoneticConfig):"No phonetic labels yet."}</p></div>
    </div>
    <div className="tb-ground-actions">
      <button type="button" onClick={exportGrid}><Download size={14}/> Export TextGrid</button>
      <label className="tb-textgrid-upload"><FileUp size={14}/> Import TextGrid
        <input type="file" accept=".TextGrid,.textgrid,text/plain" onChange={e=>void importGrid(e.target.files?.[0])}/>
      </label>
    </div>
    <p className="tb-inset">Phone intervals are independent of word boundaries. TextGrid may lose parent IDs: annotation JSON remains canonical.</p>
    {notice && <p className="tb-ground-notice" role="status">{notice}</p>}
  </div>;
}

/**
 * Lightweight waveform player for the DISPLAY-ONLY `audio_player` block.
 * It reuses the same decoded waveform and seconds-to-pixels conversion as
 * the annotation editor, but deliberately has NO annotation answer state.
 * A Task Builder may place several such players around the questions.
 */
export function AudioWaveformPlayer({url}:{url:string}) {
  const audio=useRef<HTMLAudioElement>(null);
  const [duration,setDuration]=useState(0);
  const [current,setCurrent]=useState(0);
  const [viewStart,setViewStart]=useState(0);
  const [viewLength,setViewLength]=useState(10);
  const [selection,setSelection]=useState<[number,number]|null>(null);
  function zoom(factor:number){
    if(!duration)return;
    const length=clamp(viewLength/factor,Math.min(.25,duration),duration);
    setViewLength(length);setViewStart(clamp(current-length/2,0,Math.max(0,duration-length)));
  }
  return <div className="tb-standalone-waveform">
    <audio controls ref={audio} src={url} preload="metadata" onLoadedMetadata={event=>{
      const seconds=event.currentTarget.duration;
      if(Number.isFinite(seconds) && seconds>0){setDuration(seconds);setViewLength(Math.min(seconds,10));setViewStart(0);}
    }} onTimeUpdate={event=>setCurrent(event.currentTarget.currentTime)}/>
    <Waveform url={url} duration={duration} currentTime={current} viewStart={viewStart}
      viewLength={viewLength} selection={selection} onSelect={setSelection}
      onSeek={seconds=>{if(audio.current)audio.current.currentTime=seconds;setCurrent(seconds);}}/>
    <div className="tb-ground-toolbar">
      <button type="button" onClick={()=>zoom(1.8)} disabled={!duration} aria-label="Zoom waveform in"><ZoomIn size={14}/></button>
      <button type="button" onClick={()=>zoom(1/1.8)} disabled={!duration} aria-label="Zoom waveform out"><ZoomOut size={14}/></button>
      <small>{current.toFixed(2)} / {duration.toFixed(2)} s</small>
      <button type="button" disabled={!selection || selection[1]<=selection[0]}
        onClick={()=>{if(!audio.current || !selection)return;audio.current.currentTime=selection[0];void audio.current.play();}}>
        Play selected region
      </button>
    </div>
    <label className="tb-scroll-label">Scroll waveform
      <input type="range" min={0} max={Math.max(0,duration-viewLength)} step={.01} value={viewStart}
        onChange={event=>setViewStart(Number(event.target.value))} disabled={!duration}/>
    </label>
  </div>;
}
