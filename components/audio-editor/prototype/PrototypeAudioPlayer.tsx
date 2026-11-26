"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * ORIGINAL PROTOTYPE WORKBENCH PORT.
 * This file retains the original audio interaction implementation: a single
 * shared time selection synchronizes waveform, acoustics and every tier.
 * Differences from the prototype are intentionally limited to imports and
 * the external adapter in AudioGroundingEditor.tsx.
 *
 * IMPORTANT: the `selection` prop is controlled by the adapter. The prototype
 * owns its viewport and drag state; it does NOT save server annotations.
 * The adapter maps each edit back to answers[block.id].tiers.
 *
 * Directly copying the prototype here preserves subtle interactions that
 * were lost in the simplified editor (boundary handles, cursor/selection,
 * speed, looping, range playback, focus mode, phonetic symbol insertion).
 */
import {
  Play,
  Pause,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Headphones,
  Save,
  Plus,
} from "lucide-react";
import {
  acquireAudio,
  visiblePeaks,
  type DecodedAudio,
} from "@/lib/audio/prototype/audio-cache";
import { PreferenceControls, usePreferences } from "./preferences";
import { coverageSeconds } from "./bridge";
import { Badge, clientId } from "./bridge";
import { Acoustics } from "./acoustics";
import {
  moveGroundingRange,
  resizeGroundingRange,
} from "@/lib/audio/grounding-selection";
import { timelineLanes } from "@/lib/audio/prototype/timeline";
import { PhoneticPalette } from "./phonetics";
type Tier = { id: string; label: string; items: any[] };
type Props = {
  assets: any[];
  selection: [number, number];
  onSelection: (r: [number, number]) => void;
  role: string;
  onRole: (r: string) => void;
  coverage: Record<string, number[][]>;
  onCoverage: (r: string, ranges: number[][]) => void;
  intervals?: any[];
  precision?: number;
  onIntervalMove?: (id: string, start: number, end: number) => void;
  speech?: boolean;
  aids?: any;
  tiers?: Tier[];
  phonetics?: any;
  onSegment?: (tier: string, item: any, linked?: boolean) => void;
  onSegmentDelete?: (tier: string, id: string) => void;
  onPending?: (value: boolean) => void;
  annotation?: any;
  taskActions?: React.ReactNode;
  focusSegment?: { tier: string; item: any; key: string } | null;
};
export function PrototypeAudioPlayer({
  assets,
  selection,
  onSelection,
  role,
  onRole,
  coverage,
  onCoverage,
  intervals = [],
  precision = 0.01,
  speech = false,
  aids = {},
  tiers = [],
  phonetics = { alphabet: "IPA", level: "broad", symbols: [] },
  onSegment,
  onSegmentDelete,
  onPending,
  focusSegment,
  annotation = {},
  taskActions,
}: Props) {
  // Aids are configured by the *published definition*, not by the queue row.
  // Keep every enabled aid available for sound as well as speech tasks.
  const wantsAcoustics = Boolean(
    aids.spectrogram || aids.pitch || aids.energy || aids.formants || aids.mfcc,
  );
  // The acoustic worker intentionally limits computation to a <=20 s viewport.
  // Show the FIRST 20 seconds initially for longer clips, keeping later audio
  // accessible through the existing timeline scrollbar. This is view state only.
  const analysisWindow = (seconds: number) =>
    wantsAcoustics ? Math.min(seconds, 20) : seconds;
  const { language } = usePreferences();
  const [focus, setFocus] = useState(false),
    [waveHeight, setWaveHeight] = useState(90),
    [tierHeight, setTierHeight] = useState(180),
    [resolution, setResolution] = useState("task"),
    [mediaUrl, setMediaUrl] = useState(""),
    [retry, setRetry] = useState(0);
  const rmsById = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!focus) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement))
        setFocus(false);
    };
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", key);
    };
  }, [focus]);
  // Selection visibility is transient per workbench; saved interval boundaries
  // remain in the controlled parent answer when its editor is dismissed.
  const playerRoot = useRef<HTMLElement>(null);
  const dismissRef = useRef<() => void>(() => {});
  const [selectionVisible, setSelectionVisible] = useState(false);
  const audio = useRef<HTMLAudioElement>(null),
    wave = useRef<HTMLDivElement>(null),
    labelInput = useRef<HTMLInputElement>(null),
    last = useRef<number | null>(null),
    coverageRef = useRef(coverage),
    drag = useRef<any>(null),
    stopAt = useRef<number | null>(null),
    switchTime = useRef(0),
    resume = useRef(false),
    selectionRef = useRef(selection);
  const [decoded, setDecoded] = useState<Record<string, DecodedAudio>>({}),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [playing, setPlaying] = useState(false),
    [time, setTime] = useState(0),
    [view, setView] = useState<[number, number]>([
      0,
      analysisWindow(assets[0].duration),
    ]),
    [speed, setSpeed] = useState("1"),
    [loop, setLoop] = useState(false),
    [autoPlay, setAutoPlay] = useState(false),
    [volume, setVolume] = useState(1),
    [matched, setMatched] = useState(false),
    [linked, setLinked] = useState(false),
    [tierId, setTierId] = useState(tiers[0]?.id || "events"),
    [draft, setDraft] = useState<any>(null),
    [label, setLabel] = useState(""),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  const [cursor, setCursor] = useState(0),
    [editor, setEditor] = useState<"popup" | "inline" | null>(null),
    [popupAt, setPopupAt] = useState<"wave" | "plots">("wave"),
    [speaker, setSpeaker] = useState(annotation.speakers?.[0] || "Speaker 1"),
    [concept, setConcept] = useState(""),
    [layout, setLayout] = useState(annotation.lane_layout || "overlap");
  const concepts: any[] = annotation.sound_concepts || [],
    speakers: string[] = annotation.speakers || ["Speaker 1", "Speaker 2"];
  /**
   * Audio metadata and the currently selected role live outside this component.
   * The adapter supplies one primary recording from AudioLab 2.0's R2 asset.
   * `offset` and `windowSize` are measured in SECONDS, not pixel coordinates;
   * zoom/pan change only which portion is visible, never stored labels.
   */
  const asset = assets.find((a) => a.role === role) || assets[0],
    duration = asset.duration,
    offset = Math.min(view[0], duration),
    viewEnd = Math.min(view[1], duration),
    windowSize = Math.max(1 / asset.sample_rate, viewEnd - offset),
    step =
      resolution === "sample"
        ? 1 / asset.sample_rate
        : resolution === "fine"
          ? 0.001
          : precision,
    snap = (v: number) =>
      Math.max(0, Math.min(duration, Math.round(v / step) * step));
  coverageRef.current = coverage;
  selectionRef.current = selection;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  function mark(v: boolean) {
    pendingRef.current = v;
    setPending(v);
    onPending?.(v);
    setNotice("");
  }
  // Complete labelled edits locally when moving elsewhere; cursor-only changes never trigger a dialog.
  function abandon() {
    if (pendingRef.current && label.trim()) {
      if (saveSegment()) return true;
      mark(false);
      setNotice(
        "Invalid edit was not applied; the existing annotation was retained.",
      );
      return true;
    }
    if (pendingRef.current) {
      mark(false);
      setNotice("Empty edit dismissed; existing annotations were retained.");
    }
    return true;
  }
  /** Outside clicks apply valid local edits before dismissing view state. Neither
   * a blank new selection nor an invalid edit deletes a controlled annotation.
   * Capture phase runs before a later Save/Submit click reads parent answers.
   */
  function dismissSelection() {
    if (!selectionVisible && !draft && !pendingRef.current) return;
    abandon();
    audio.current?.pause();
    stopAt.current = null;
    drag.current = null;
    setEditor(null);
    setDraft(null);
    setLabel("");
    setSelectionVisible(false);
    onSelection([0, 0]);
    selectionRef.current = [0, 0];
    setError("");
  }
  dismissRef.current = dismissSelection;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const root = playerRoot.current,
        target = event.target;
      if (!root || !(target instanceof Element) || drag.current) return;
      // Editor fields, segment handles and playback controls keep the current
      // selection. Another workbench is outside THIS instance and dismisses it.
      if (
        root.contains(target) &&
        target.closest(
          "[data-segment],.r-range-grip,.r-inline-editor,.r-range-popover,.r-segment-editor,button,input,select,textarea",
        )
      )
        return;
      dismissRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);
  useEffect(() => {
    setView([0, analysisWindow(duration)]);
    setDraft(null);
    setLabel("");
    setEditor(null);
    setSelectionVisible(false);
    setCursor(0);
    mark(false);
  }, [asset.id, duration, wantsAcoustics]);
  /**
   * Prototype audio cache: fetch the recording and decode PCM for waveform and
   * acoustic analysis. Each lease is released on URL change/unmount. The
   * adapter never embeds raw audio bytes or local object URLs in annotations.
   */
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError("");
    setMediaUrl("");
    setDecoded({});
    const lease = acquireAudio(asset);
    lease.promise
      .then(async (resource) => {
        if (canceled) return;
        setMediaUrl(resource.url);
        const result = await resource.decoded;
        if (!canceled) {
          rmsById.current[asset.id] = result.rms;
          setDecoded({ [asset.id]: result });
        }
      })
      .catch((e) => {
        if (!canceled && e.name !== "AbortError")
          setError(e.message || "Audio could not load.");
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
      lease.release();
    };
  }, [asset.id, asset.url, retry]);
  useEffect(() => {
    if (audio.current) {
      audio.current.playbackRate = +speed;
      const rms = decoded[asset.id]?.rms,
        values = assets
          .map((a) => rmsById.current[a.id] || 0)
          .filter((v) => v > 0);
      audio.current.volume = Math.max(
        0,
        Math.min(
          1,
          volume *
            (matched && rms && values.length ? Math.min(...values) / rms : 1),
        ),
      );
    }
  }, [speed, volume, asset.id, matched, decoded]);
  /**
   * Listening coverage accumulates a UNION of actually traversed intervals.
   * These intervals are UI telemetry only; the persisted answer contains
   * labelled segments, not playback coverage. Coverage alone cannot prove
   * whether the annotator paid attention to the sound.
   */
  function record(final = false) {
    const a = audio.current;
    if (!a) return;
    const t = a.currentTime;
    setTime(t);
    const previous = last.current;
    if (
      previous !== null &&
      (!a.paused || final) &&
      !a.seeking &&
      t >= previous &&
      t - previous < 1.6 * Number(speed)
    ) {
      const ranges = [...(coverageRef.current[role] || []), [previous, t]].sort(
          (a, b) => a[0] - b[0],
        ),
        merged: number[][] = [];
      for (const r of ranges) {
        const prev = merged.at(-1);
        if (prev && r[0] <= prev[1] + 0.04) prev[1] = Math.max(prev[1], r[1]);
        else merged.push([...r]);
      }
      coverageRef.current = { ...coverageRef.current, [role]: merged };
      onCoverage(role, merged);
    }
    last.current = a.paused ? null : t;
  }
  // A short animation loop stops audition at the selected boundary, not the next timeupdate event.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    function tick() {
      const a = audio.current;
      if (a) {
        setTime(a.currentTime);
        if (stopAt.current !== null && a.currentTime >= stopAt.current) {
          record(true);
          if (loop) {
            last.current = null;
            a.currentTime = selectionRef.current[0];
          } else {
            a.pause();
            a.currentTime = stopAt.current;
            setTime(a.currentTime);
          }
        }
      }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, loop]);
  function playRange(start = selection[0], end = selection[1]) {
    const a = audio.current;
    if (!a) return;
    last.current = null;
    a.currentTime = start;
    stopAt.current = end > start ? end : duration;
    void a
      .play()
      .catch(() => setError("Press Play again to allow audio playback."));
  }
  function toggle() {
    if (!audio.current) return;
    if (playing) audio.current.pause();
    else
      playRange(
        selection[1] > selection[0] ? selection[0] : cursor,
        selection[1] > selection[0] ? selection[1] : duration,
      );
  }
  /**
   * Zoom preserves the selection/cursor as the visual center, reproducing the
   * original interaction. It does NOT quantize stored interval timestamps;
   * timing precision is separately configured by the Task Definition.
   */
  function zoom(factor: number) {
    const size = Math.max(
        Math.max(0.001, 16 / asset.sample_rate),
        Math.min(duration, windowSize / factor),
      ),
      center =
        selection[1] > selection[0]
          ? (selection[0] + selection[1]) / 2
          : cursor,
      s = Math.max(0, Math.min(duration - size, center - size / 2));
    setView([s, s + size]);
  }
  function fitSelection() {
    if (selection[1] <= selection[0]) return;
    const pad = (selection[1] - selection[0]) * 0.15;
    setView([
      Math.max(0, selection[0] - pad),
      Math.min(duration, selection[1] + pad),
    ]);
  }
  /**
   * Clicking an existing word, phone, or sound event selects its time interval
   * across ALL visible aids. The same `selection` prop drives the waveform,
   * acoustic overlays, tier-highlight markers, and timing tables in the v2
   * adapter. This shared selection is the critical research-workbench invariant.
   */
  function choose(tier: string, item: any, focusLabel = true) {
    setSelectionVisible(true);
    if (draft?.id === item.id && tierId === tier && pending) {
      setEditor("inline");
      if (focusLabel) labelInput.current?.focus();
      return true;
    }
    if (!abandon()) return false;
    setTierId(tier);
    setDraft({ ...item });
    setLabel(item.text);
    setConcept(item.concept_id || "other");
    setSpeaker(item.speaker || speakers[0]);
    onSelection([item.start, item.end]);
    selectionRef.current = [item.start, item.end];
    setCursor(item.start);
    setEditor("inline");
    mark(false);
    if (focusLabel) requestAnimationFrame(() => labelInput.current?.focus());
    return true;
  }
  function newSelection(r: [number, number]) {
    const next: [number, number] = [snap(r[0]), snap(r[1])];
    onSelection(next);
    selectionRef.current = next;
    setSelectionVisible(true);
    setCursor(next[0]);
    setDraft(null);
    setLabel("");
    setConcept("");
    mark(false);
  }
  function saveSegment() {
    const range = selectionRef.current;
    if (!onSegment || range[1] <= range[0] || !label.trim()) {
      setError("Drag a range and enter a label before saving.");
      return false;
    }
    const item = {
      ...draft,
      id: draft?.id || clientId(),
      text: label.trim(),
      start: range[0],
      end: range[1],
      ...(speech
        ? { speaker }
        : concepts.length
          ? { concept_id: concept || "other" }
          : {}),
    };
    try {
      onSegment(tierId, item, linked);
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
    setDraft(item);
    setLabel(item.text);
    mark(false);
    setError("");
    setNotice(
      "Segment saved in this draft. Use Save draft or Submit annotation to store your work on your account.",
    );
    return true;
  }
  function insertSymbol(symbol: string) {
    const el = labelInput.current,
      start = el?.selectionStart ?? label.length,
      end = el?.selectionEnd ?? start;
    setLabel(label.slice(0, start) + symbol + label.slice(end));
    mark(true);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + symbol.length, start + symbol.length);
    });
  }
  function at(e: React.PointerEvent, el = e.currentTarget) {
    const r = el.getBoundingClientRect();
    return snap(
      offset +
        Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * windowSize,
    );
  }
  /**
   * Original pointer-capture drag mechanism. Dragging on waveform or a tier
   * captures the pointer, converts horizontal client pixels to seconds,
   * updates ONE shared selection range, then opens the contextual label editor.
   * Do not give every tier its own selection state: that was the regression
   * in the simplified grounding block that this port replaces.
   */
  function startSelection(
    e: React.PointerEvent,
    source: "popup" | "inline" = "popup",
    tier?: string,
  ) {
    if ((e.target as HTMLElement).closest("button,input,select,[data-segment]"))
      return;
    if (!abandon()) return;
    audio.current?.pause();
    setPopupAt("wave");
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = at(e),
      start = e.shiftKey ? cursor : t;
    drag.current = { kind: "select", start, source };
    if (tier) setTierId(tier);
    setEditor(null);
    newSelection([Math.min(start, t), Math.max(start, t)]);
  }
  /** Capture on the lane so dragging a short imported label can cross its DOM
   * bounds. Select before moving; the existing ID and tier are retained when
   * the adapter validates and commits the edit into the controlled answer.
   */
  function segmentPointer(
    e: React.PointerEvent,
    item: {
      id: string;
      start: number;
      end: number;
      text: string;
      speaker?: string;
    },
    tier: string,
  ) {
    if ((e.target as Element).closest(".r-tier-handle")) return;
    e.stopPropagation();
    if (!choose(tier, item, false)) return;
    const lane = e.currentTarget.closest("[data-lane]");
    if (!onSegment || !lane) return;
    audio.current?.pause();
    lane.setPointerCapture(e.pointerId);
    drag.current = {
      kind: "segment",
      start: at(e, lane),
      range: [...selectionRef.current],
      source: "inline",
    };
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const t = at(e);
    if (d.kind === "select")
      newSelection([Math.min(d.start, t), Math.max(d.start, t)]);
    else {
      const previous = selectionRef.current;
      const range =
        d.kind === "segment"
          ? moveGroundingRange(d.range, t - d.start, duration)
          : resizeGroundingRange(
              previous,
              d.kind === "start" ? "start" : "end",
              t,
              duration,
              asset.sample_rate,
            );
      if (range[0] !== previous[0] || range[1] !== previous[1]) {
        selectionRef.current = range;
        onSelection(range);
        setCursor(range[0]);
        mark(true);
        setSelectionVisible(true);
      }
    }
  }

  function finishSelection(source: "popup" | "inline" = "popup") {
    setEditor(source);
    if (selectionRef.current[1] > selectionRef.current[0])
      requestAnimationFrame(() => labelInput.current?.focus());
    if (autoPlay) playRange(selectionRef.current[0], selectionRef.current[1]);
  }
  function release(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "select") {
      if (selectionRef.current[1] > selectionRef.current[0])
        finishSelection(d.source);
      else dismissSelection();
    } else if (d) setEditor(d.source || "inline");
  }
  /**
   * Editing a segment edge reuses the selection handles. The adapter saves
   * canonical start/end seconds; optional adjacent-boundary linkage is applied
   * to the same-tier intervals by commitSegment() in the v2 adapter.
   */
  function boundary(
    e: React.PointerEvent,
    which: string,
    item: any,
    tier: string,
  ) {
    e.stopPropagation();
    if (!onSegment) return;
    if ((draft?.id !== item.id || tierId !== tier) && !abandon()) return;
    setSelectionVisible(true);
    setTierId(tier);
    if (draft?.id !== item.id || tierId !== tier) {
      setDraft({ ...item });
      setLabel(item.text);
      setSpeaker(item.speaker || speakers[0]);
      setConcept(item.concept_id || "other");
      onSelection([item.start, item.end]);
      selectionRef.current = [item.start, item.end];
    }
    setEditor("inline");
    const lane = e.currentTarget.closest("[data-lane]");
    lane?.setPointerCapture(e.pointerId);
    drag.current = { kind: which };
  }
  function nudge(
    e: React.KeyboardEvent,
    which: "start" | "end",
    item: any,
    tier: string,
  ) {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    if (!onSegment) return;
    if ((draft?.id !== item.id || tierId !== tier) && !abandon()) return;
    const r: [number, number] =
      draft?.id === item.id && tierId === tier
        ? [...selection]
        : [item.start, item.end];
    r[which === "start" ? 0 : 1] = snap(
      r[which === "start" ? 0 : 1] + (e.key === "ArrowLeft" ? -step : step),
    );
    if (r[1] <= r[0]) return;
    setTierId(tier);
    if (draft?.id !== item.id || tierId !== tier) {
      setDraft(item);
      setLabel(item.text);
      setSpeaker(item.speaker || speakers[0]);
      setConcept(item.concept_id || "other");
    }
    setEditor("inline");
    onSelection(r);
    setCursor(r[which === "start" ? 0 : 1]);
    mark(true);
  }
  function cancelEdit() {
    if (draft) {
      onSelection([draft.start, draft.end]);
      setLabel(draft.text);
    } else onSelection([cursor, cursor]);
    mark(false);
    setEditor(null);
    setDraft(null);
    setSelectionVisible(false);
    setError("");
  }
  useEffect(() => {
    if (!draft || pendingRef.current) return;
    const current = tiers
      .find((t) => t.id === tierId)
      ?.items.find((i) => i.id === draft.id);
    if (!current) {
      setDraft(null);
      setEditor(null);
      setSelectionVisible(false);
      onSelection([0, 0]);
      return;
    }
    if (
      current.text !== draft.text ||
      current.start !== draft.start ||
      current.end !== draft.end ||
      current.speaker !== draft.speaker ||
      current.concept_id !== draft.concept_id
    ) {
      setDraft({ ...current });
      setLabel(current.text);
      setSpeaker(current.speaker || speakers[0]);
      setConcept(current.concept_id || "other");
      onSelection([current.start, current.end]);
    }
  }, [tiers]);
  useEffect(() => {
    if (focusSegment) choose(focusSegment.tier, focusSegment.item);
  }, [focusSegment?.key]);
  useEffect(() => {
    if (!aids.shortcuts) return;
    const key = (e: KeyboardEvent) => {
      if (
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.target instanceof HTMLElement &&
          (/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName) ||
            e.target.isContentEditable))
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoom(2);
      } else if (e.key === "-") {
        e.preventDefault();
        zoom(0.5);
      } else if (e.key === "Escape") {
        audio.current?.pause();
      } else if (e.key === "[" || e.key === "]") {
        const t = snap(audio.current?.currentTime || 0);
        onSelection(
          e.key === "["
            ? [Math.min(t, selection[1]), selection[1]]
            : [selection[0], Math.max(t, selection[0])],
        );
        mark(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [aids.shortcuts, selection, playing, view]);
  const peaks = decoded[asset.id]?.peaks || [],
    visible = useMemo(
      () =>
        decoded[asset.id]
          ? visiblePeaks(decoded[asset.id], offset, viewEnd)
          : [],
      [decoded, asset.id, offset, viewEnd],
    ),
    max = Math.max(0.1, ...peaks),
    percent = (t: number) => ((t - offset) / windowSize) * 100;
  const displayTiers = tiers.length
    ? tiers
    : [
        {
          id: "events",
          label: "Regions",
          items: intervals.filter((i) => i.asset_role === role),
        },
      ];
  const drawn = displayTiers.flatMap((t) =>
    t.items.map((i) =>
      draft?.id === i.id && tierId === t.id
        ? { ...i, start: selection[0], end: selection[1], text: label }
        : i,
    ),
  );
  const boundaries = drawn.flatMap((i) => [i.start, i.end]);
  /**
   * Shared display markers. Both range boundaries and the cursor are drawn
   * over waveform and tier lanes. The acoustic worker also receives exactly
   * this `selection`, maintaining synchronized time coordinates across views.
   */
  const markers = (times = true, handles = false) => (
    <>
      {selectionVisible && selection[1] > selection[0] && (
        <div
          className="r-selection"
          style={{
            left: `${Math.max(0, percent(selection[0]))}%`,
            width: `${Math.max(0, Math.min(100, percent(selection[1])) - Math.max(0, percent(selection[0])))}%`,
          }}
        />
      )}
      {(selectionVisible ? [...new Set([cursor, ...selection])] : [])
        .filter((t) => t >= offset && t <= viewEnd)
        .map((t, i) => (
          <div
            key={i}
            className="r-edit-cursor"
            style={{ left: `${percent(t)}%` }}
          >
            {times && (
              <span
                style={{
                  transform: percent(t) > 85 ? "translateX(-100%)" : undefined,
                }}
              >
                {t.toFixed(resolution === "sample" ? 6 : 3)} s
              </span>
            )}
            {handles &&
              onSegment &&
              selection[1] > selection[0] &&
              (t === selection[0] || t === selection[1]) && (
                <span
                  className="r-range-grip"
                  role="slider"
                  tabIndex={0}
                  aria-label={
                    t === selection[0]
                      ? "Selection start boundary"
                      : "Selection end boundary"
                  }
                  aria-valuemin={0}
                  aria-valuemax={duration}
                  aria-valuenow={t}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    wave.current?.setPointerCapture(e.pointerId);
                    drag.current = {
                      kind: t === selection[0] ? "start" : "end",
                      source: editor || "popup",
                    };
                  }}
                  onKeyDown={(e) => {
                    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
                    e.preventDefault();
                    const r: [number, number] = [...selection];
                    r[t === selection[0] ? 0 : 1] = snap(
                      t + (e.key === "ArrowLeft" ? -step : step),
                    );
                    if (r[1] > r[0]) {
                      onSelection(r);
                      mark(!!label);
                      setEditor(editor || "popup");
                    }
                  }}
                />
              )}
          </div>
        ))}
      {playing && time >= offset && time <= viewEnd && (
        <div className="r-playhead" style={{ left: `${percent(time)}%` }} />
      )}
    </>
  );
  /**
   * The ORIGINAL contextual segment editor: label, speaker, optional concept,
   * independent start/end numbers, adjacent boundary link, hear/save/delete,
   * and an IPA symbol palette for Speech/phone tiers. This is retained from
   * the prototype rather than redrawn as a generic Task Builder form.
   */
  const entry = (
    <div
      className="r-direct-editor"
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          e.target instanceof HTMLInputElement &&
          e.target.type === "number"
        ) {
          e.preventDefault();
          saveSegment();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="r-row">
        <b>
          {draft ? "Edit" : "New"}{" "}
          {tierId === "phones"
            ? "phone"
            : tierId === "words"
              ? "word"
              : "sound"}
        </b>
        <span className="r-hint">
          {selection[0].toFixed(resolution === "sample" ? 6 : 3)}–
          {selection[1].toFixed(resolution === "sample" ? 6 : 3)} s ·{" "}
          {(selection[1] - selection[0]).toFixed(
            resolution === "sample" ? 6 : 3,
          )}{" "}
          s
        </span>
        <button className="button small" onClick={cancelEdit}>
          Cancel
        </button>
      </div>
      <div className="r-row">
        {editor === "popup" && (
          <select
            aria-label="Label tier"
            value={tierId}
            onChange={(e) => {
              if (abandon()) {
                setTierId(e.target.value);
                setDraft(null);
                setLabel("");
                mark(false);
              }
            }}
          >
            {displayTiers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        )}
        {speech && (
          <select
            aria-label="Segment speaker"
            value={speaker}
            onChange={(e) => {
              setSpeaker(e.target.value);
              mark(true);
            }}
          >
            {speakers.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        )}
        {!speech && concepts.length > 0 && (
          <select
            aria-label="Sound concept"
            value={concept}
            onChange={(e) => {
              setConcept(e.target.value);
              setLabel(
                concepts.find((c) => c.id === e.target.value)?.label || "",
              );
              mark(true);
            }}
          >
            <option value="" disabled>
              Choose sound concept
            </option>
            {concepts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
            <option value="other">Other…</option>
          </select>
        )}
        {(speech || !concepts.length || concept === "other") && (
          <input
            ref={labelInput}
            aria-label="Segment label"
            className="field r-direct-label"
            value={label}
            placeholder={
              tierId === "phones"
                ? "Type or insert phonetic symbols"
                : concept === "other"
                  ? "Describe the other sound"
                  : "Enter label"
            }
            onChange={(e) => {
              setLabel(e.target.value);
              mark(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveSegment();
              }
              if (e.key === "Escape") cancelEdit();
            }}
          />
        )}
        <button
          className="button primary"
          onClick={saveSegment}
          disabled={selection[1] <= selection[0] || !label.trim()}
        >
          <Save size={14} /> Save segment
        </button>
        <button className="button small" onClick={() => playRange()}>
          ▶ Hear
        </button>
        {draft && onSegmentDelete && (
          <button
            className="button small"
            onClick={() => {
              onSegmentDelete(tierId, draft.id);
              setDraft(null);
              setLabel("");
              mark(false);
              setEditor(null);
            }}
          >
            Delete
          </button>
        )}
      </div>
      <div className="r-row r-direct-times">
        <label>
          Start{" "}
          <input
            type="number"
            step={step}
            min={0}
            max={selection[1]}
            aria-label="Segment start"
            value={selection[0]}
            onChange={(e) => {
              const t = snap(+e.target.value);
              if (t < selection[1]) {
                onSelection([t, selection[1]]);
                setCursor(t);
                mark(!!label);
              }
            }}
          />
        </label>
        <label>
          End{" "}
          <input
            type="number"
            step={step}
            min={selection[0]}
            max={duration}
            aria-label="Segment end"
            value={selection[1]}
            onChange={(e) => {
              const t = snap(+e.target.value);
              if (t > selection[0]) {
                onSelection([selection[0], t]);
                mark(!!label);
              }
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={linked}
            onChange={(e) => setLinked(e.target.checked)}
          />{" "}
          Link adjacent boundaries
        </label>
      </div>
      {speech && tierId === "phones" && (
        <PhoneticPalette config={phonetics} onInsert={insertSymbol} />
      )}
      <small>
        Enter saves this segment. Clicking outside saves valid labelled edits to
        this local draft and closes selection. Empty edits are dismissed without
        deleting annotations. Save draft below stores your account revision.
      </small>
    </div>
  );
  return (
    <section
      ref={playerRoot}
      data-selection-active={selectionVisible}
      className={`panel r-player r-workbench ${focus ? "r-workbench-focus" : ""}`}
      style={
        {
          "--wave-height": `${waveHeight}px`,
          "--tier-height": `${tierHeight}px`,
        } as React.CSSProperties
      }
    >
      <div className="r-player-top">
        <div className="r-row">
          <Headphones size={17} />
          <b>{speech ? "Speech" : "Sound"} workbench</b>
          <Badge>{duration.toFixed(resolution === "sample" ? 6 : 3)} s</Badge>
        </div>
        <div className="r-row">
          <PreferenceControls />
          <button
            className="button small"
            aria-pressed={focus}
            onClick={() => setFocus(!focus)}
          >
            {focus
              ? language === "th"
                ? "ออกจากโหมดทำงาน"
                : "Exit work mode"
              : language === "th"
                ? "ขยายพื้นที่ทำงาน"
                : "Expand work area"}
          </button>
        </div>
      </div>
      {assets.length > 1 && (
        <div className="r-asset-tabs">
          {assets.map((a) => (
            <button
              key={a.role}
              className={role === a.role ? "active" : ""}
              onClick={() => {
                if (abandon()) {
                  switchTime.current = audio.current?.currentTime || 0;
                  resume.current = playing;
                  audio.current?.pause();
                  stopAt.current = null;
                  onRole(a.role);
                  onSelection([0, 0]);
                }
              }}
            >
              {a.role}
            </button>
          ))}
          <label className="r-check">
            <input
              type="checkbox"
              checked={matched}
              onChange={(e) => setMatched(e.target.checked)}
            />{" "}
            Match decoded RMS levels
          </label>
        </div>
      )}
      <div className="r-bench-toolbar">
        <button
          className="r-play"
          disabled={!mediaUrl}
          aria-label={playing ? "Pause audio" : "Play selection or cursor"}
          onClick={toggle}
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </button>
        <button
          className="button small"
          onClick={() => playRange(offset, viewEnd)}
        >
          Play visible
        </button>
        <button
          className="button small"
          onClick={() => {
            setView([0, duration]);
            audio.current?.pause();
            setTime(0);
          }}
        >
          <RotateCcw size={14} /> Full clip
        </button>
        <button
          className="button small"
          aria-label="Zoom in"
          onClick={() => zoom(2)}
        >
          <ZoomIn size={15} />
        </button>
        <button
          className="button small"
          aria-label="Zoom out"
          onClick={() => zoom(0.5)}
        >
          <ZoomOut size={15} />
        </button>
        <button
          className="button small"
          disabled={selection[1] <= selection[0]}
          onClick={fitSelection}
        >
          Fit selection
        </button>
        <select
          aria-label="Playback speed"
          value={speed}
          onChange={(e) => setSpeed(e.target.value)}
        >
          {[".5", ".75", "1", "1.25", "1.5"].map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={autoPlay}
            onChange={(e) => setAutoPlay(e.target.checked)}
          />{" "}
          Play after selection
        </label>
        <label>
          <input
            type="checkbox"
            checked={loop}
            onChange={(e) => setLoop(e.target.checked)}
          />{" "}
          Loop selection
        </label>
      </div>
      <details className="r-layout-settings">
        <summary>
          {language === "th" ? "ปรับพื้นที่และความละเอียด" : "Layout & timing"}{" "}
          ·{" "}
          {resolution === "sample"
            ? "sample"
            : `${(step * 1000).toFixed(1)} ms`}{" "}
          · {asset.sample_rate / 1000} kHz
        </summary>
        <div className="r-row">
          <label>
            Timing step{" "}
            <select
              aria-label="Timing precision"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            >
              <option value="task">Task step · {precision * 1000} ms</option>
              <option value="fine">Fine · 1 ms</option>
              <option value="sample">
                One sample · {(1000 / asset.sample_rate).toFixed(3)} ms
              </option>
            </select>
          </label>
          <label>
            Waveform height{" "}
            <input
              aria-label="Waveform height"
              type="range"
              min="45"
              max="160"
              value={waveHeight}
              onChange={(e) => setWaveHeight(+e.target.value)}
            />
          </label>
          <label>
            Tier area height{" "}
            <input
              aria-label="Tier area height"
              type="range"
              min="90"
              max="320"
              value={tierHeight}
              onChange={(e) => setTierHeight(+e.target.value)}
            />
          </label>
          <button
            className="button small"
            onClick={() => {
              setWaveHeight(90);
              setTierHeight(180);
            }}
          >
            Reset layout
          </button>
        </div>
        <p className="r-hint">
          Zoom is independent of timing step. Fine/sample steps affect new edits
          only; the original protocol remains {precision * 1000} ms. Browser
          playback timing is approximate.
        </p>
      </details>
      <div className="r-bench-status">
        <span>
          Cursor {cursor.toFixed(resolution === "sample" ? 6 : 3)} s · selection{" "}
          {selection[0].toFixed(resolution === "sample" ? 6 : 3)}–
          {selection[1].toFixed(resolution === "sample" ? 6 : 3)} s
        </span>
        <span>
          {language === "th"
            ? "คลิก: วางเส้นเวลา · ลาก: เลือกและใส่ป้าย · Shift+คลิก: ขยายช่วง · Space: ฟัง"
            : "Click: cursor · drag: select & label · Shift-click: extend · Space: listen"}
        </span>
      </div>
      <audio
        ref={audio}
        src={mediaUrl || undefined}
        preload="metadata"
        onLoadedMetadata={() => {
          const a = audio.current;
          if (a) {
            a.currentTime = Math.min(switchTime.current, duration);
            a.playbackRate = +speed;
            if (resume.current) {
              resume.current = false;
              void a.play().catch(() => {});
            }
          }
        }}
        onTimeUpdate={() => record()}
        onPlay={() => {
          setPlaying(true);
          last.current = audio.current!.currentTime;
        }}
        onPause={() => {
          record(true);
          setPlaying(false);
          last.current = null;
        }}
        onSeeking={() => {
          last.current = null;
        }}
        onSeeked={() => {
          last.current = audio.current?.currentTime || 0;
        }}
        onEnded={() => {
          record(true);
          setPlaying(false);
          last.current = null;
        }}
        onError={() =>
          setError(
            "Audio could not be played. Reopen the task to refresh its link.",
          )
        }
      />
      {/* Waveform, acoustic analysis and tier lanes live under one viewport. */}
      <div className="r-timeline-viewport">
        <div className="r-wave-wrap">
          <div
            className="r-wave"
            ref={wave}
            aria-label="Waveform: click for cursor, drag to label"
            onPointerDown={(e) => startSelection(e)}
            onPointerMove={move}
            onPointerUp={release}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <svg
              viewBox={`0 0 ${Math.max(1, visible.length)} 100`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {visible.map((p, i) => (
                <line
                  key={i}
                  x1={i}
                  x2={i}
                  y1={50 - (p / max) * 43}
                  y2={50 + (p / max) * 43}
                  stroke="#555b70"
                  strokeWidth="1.1"
                />
              ))}
            </svg>
            {loading && (
              <div className="r-wave-loading">
                {mediaUrl ? "Preparing waveform…" : "Loading audio…"}
              </div>
            )}
            {boundaries
              .filter((t) => t >= offset && t <= viewEnd)
              .map((t, i) => (
                <i
                  key={i}
                  className="r-boundary-line"
                  style={{ left: `${percent(t)}%` }}
                />
              ))}
            {markers(true, true)}
          </div>
          <div className="r-ruler">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i}>
                {(offset + (windowSize * i) / 5).toFixed(
                  resolution === "sample" ? 6 : 3,
                )}
                s
              </span>
            ))}
          </div>
          {onSegment && editor === "popup" && popupAt === "wave" && (
            <div
              className="r-range-popover"
              role="region"
              aria-label="Selected range editor"
            >
              {entry}
              {selection[1] <= selection[0] && (
                <p className="r-hint">
                  Cursor placed. Drag on a plot, Shift-click an end point, or
                  enter an end time to label a range.
                </p>
              )}
            </div>
          )}
        </div>
        {/* The ORIGINAL acoustics canvas receives the exact same shared selection.
       Its worker computes spectrogram, F0 and optional MFCC/formant estimates. */}
        {/* Do not silently disappear while a later recording is decoding. */}
        {wantsAcoustics &&
          (decoded[asset.id] ? (
            <Acoustics
              samples={decoded[asset.id].samples}
              rate={decoded[asset.id].rate}
              offset={offset}
              end={viewEnd}
              selection={selection}
              onSelection={newSelection}
              onClickTime={(t) => {
                setCursor(snap(t));
              }}
              onSelectionEnd={() => finishSelection("popup")}
              onBeforeSelect={() => {
                if (!abandon()) return false;
                audio.current?.pause();
                setPopupAt("plots");
                setEditor(null);
                return true;
              }}
              boundaries={boundaries}
              decimals={resolution === "sample" ? 6 : 3}
              cursor={selectionVisible ? cursor : -1}
              selectionVisible={selectionVisible}
              time={playing ? time : -1}
              aids={aids}
              onFit={fitSelection}
            />
          ) : (
            <div className="r-acoustics" role="status">
              <b>Acoustic aids</b>
              <p className="r-hint">
                {loading
                  ? "Preparing waveform and acoustic features…"
                  : error
                    ? `Audio analysis unavailable: ${error}`
                    : "Decoded audio is not available for this recording."}
              </p>
              {!loading && (
                <button
                  type="button"
                  className="button small"
                  onClick={() => setRetry((n) => n + 1)}
                >
                  Retry audio analysis
                </button>
              )}
            </div>
          ))}
        {onSegment && editor === "popup" && popupAt === "plots" && (
          <div
            className="r-range-popover"
            role="region"
            aria-label="Selected range editor"
          >
            {entry}
          </div>
        )}
        <div className="r-tier-layout r-row">
          <b>Annotation tiers</b>
          <select
            aria-label="Timeline layout"
            value={layout}
            onChange={(e) => setLayout(e.target.value)}
          >
            <option value="overlap">Overlap · compact lanes</option>
            <option value="separate">Separate · named lanes</option>
          </select>
          <span className="r-hint">
            Click a label to edit here. Drag either edge to refine its boundary.
          </span>
        </div>
        {/* All speech/sound tiers map one time scale into non-overlapping visual lanes;
       simultaneous real-world events remain possible when overlaps are allowed. */}
        <div className="r-time-tiers">
          {displayTiers.map((t) => {
            const changed = t.items.map((item) =>
              draft?.id === item.id && tierId === t.id
                ? {
                    ...item,
                    start: selection[0],
                    end: selection[1],
                    text: label,
                    speaker: speech ? speaker : item.speaker,
                  }
                : item,
            );
            const lanes = timelineLanes(changed, layout === "separate", speech);
            if (!lanes.length)
              lanes.push({
                label: speech ? speakers[0] : "New sound",
                items: [],
              });
            return (
              <div key={t.id} className="r-tier-block">
                <div className="r-tier-title">
                  <b>{t.label}</b>
                  <small>{t.items.length} segments</small>
                </div>
                {lanes.map((lane, li) => (
                  <div
                    key={li}
                    className={
                      layout === "separate" ? "r-named-lane" : "r-compact-lane"
                    }
                  >
                    {(layout === "separate" || speech) && (
                      <div className="r-lane-name">{lane.label}</div>
                    )}
                    <div
                      className="r-time-tier r-direct-tier"
                      data-lane="true"
                      onPointerDown={(e) => {
                        if (speech && lane.items[0]?.speaker)
                          setSpeaker(lane.items[0].speaker);
                        startSelection(e, "inline", t.id);
                      }}
                      onPointerMove={move}
                      onPointerUp={release}
                      onPointerCancel={() => {
                        drag.current = null;
                      }}
                    >
                      {lane.items
                        .filter((i) => i.end > offset && i.start < viewEnd)
                        .map((r) => {
                          const original =
                              t.items.find((i) => i.id === r.id) || r,
                            selected = draft?.id === r.id && tierId === t.id,
                            hit =
                              selectionVisible &&
                              (selection[1] > selection[0]
                                ? r.start < selection[1] && r.end > selection[0]
                                : r.start <= cursor && r.end > cursor);
                          return (
                            <div
                              data-segment="true"
                              key={r.id}
                              role="button"
                              tabIndex={0}
                              className={`r-tier-segment ${selected ? "selected" : hit ? "cursor-hit" : ""}`}
                              style={{
                                left: `${Math.max(0, percent(r.start))}%`,
                                width: `${Math.max(0.3, Math.min(100, percent(r.end)) - Math.max(0, percent(r.start)))}%`,
                              }}
                              aria-label={`${t.label}: ${r.text}, ${r.start.toFixed(resolution === "sample" ? 6 : 3)} to ${r.end.toFixed(resolution === "sample" ? 6 : 3)} seconds`}
                              onPointerDown={(e) =>
                                segmentPointer(e, original, t.id)
                              }
                              onClick={(e) => {
                                if (
                                  !(e.target as HTMLElement).closest(
                                    ".r-tier-handle",
                                  )
                                )
                                  choose(t.id, original);
                              }}
                              onKeyDown={(e) => {
                                if (
                                  e.target === e.currentTarget &&
                                  e.key === "Enter"
                                )
                                  choose(t.id, original);
                              }}
                            >
                              <span
                                className="r-tier-handle left"
                                role="slider"
                                aria-label={`Start boundary of ${r.text}`}
                                aria-valuemin={0}
                                aria-valuemax={r.end}
                                aria-valuenow={r.start}
                                tabIndex={selected ? 0 : -1}
                                onKeyDown={(e) =>
                                  nudge(e, "start", original, t.id)
                                }
                                onPointerDown={(e) =>
                                  boundary(e, "start", original, t.id)
                                }
                              />
                              <b>{r.text}</b>
                              <span
                                className="r-tier-handle right"
                                role="slider"
                                aria-label={`End boundary of ${r.text}`}
                                aria-valuemin={r.start}
                                aria-valuemax={duration}
                                aria-valuenow={r.end}
                                tabIndex={selected ? 0 : -1}
                                onKeyDown={(e) =>
                                  nudge(e, "end", original, t.id)
                                }
                                onPointerDown={(e) =>
                                  boundary(e, "end", original, t.id)
                                }
                              />
                            </div>
                          );
                        })}
                      {!lane.items.length && (
                        <span className="r-tier-empty">
                          Drag here to label a range in this tier.
                        </span>
                      )}
                      {markers(false)}
                    </div>
                  </div>
                ))}
                {onSegment && editor === "inline" && tierId === t.id && (
                  <div
                    className="r-inline-editor"
                    aria-label={`${t.label} inline editor`}
                  >
                    {entry}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {windowSize < duration && (
          <label className="r-pan">
            Visible window
            <input
              type="range"
              aria-label="Timeline scroll position"
              min={0}
              max={Math.max(0, duration - windowSize)}
              step={step}
              value={offset}
              onChange={(e) =>
                setView([+e.target.value, +e.target.value + windowSize])
              }
            />
          </label>
        )}
      </div>
      <div className="r-selection-bar">
        <span className="r-coverage">
          {Math.min(
            100,
            (coverageSeconds(coverage[role] || [], duration) / duration) * 100,
          ).toFixed(0)}
          % played
        </span>
        <label>
          Volume{" "}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            aria-label="Volume"
            onChange={(e) => setVolume(+e.target.value)}
          />
        </label>
      </div>
      {error && (
        <div className="error-banner">
          {error}
          <button
            className="button small"
            onClick={() => setRetry((x) => x + 1)}
          >
            Retry audio
          </button>
        </div>
      )}
      {notice && <div className="r-success">{notice}</div>}
      {focus && taskActions && (
        <div className="r-focus-actions">
          <button className="button small" onClick={() => setFocus(false)}>
            {language === "th"
              ? "คำถามและคำสั่งงาน"
              : "Task questions & instructions"}
          </button>
          {taskActions}
        </div>
      )}
    </section>
  );
}
