"use client";
/**
 * AudioLab 2.0 adapter around the ORIGINAL AudioLab-for-Mac research workbench.
 *
 * Why this is a wrapper rather than a redesigned waveform:
 * The prototype already has synchronized selection across the waveform,
 * spectrogram/F0 plots, and independently timed annotation tiers, with an
 * editable inline timing form, linked segment boundaries, playback range,
 * keyboard shortcuts, focus mode and IPA symbol palette. Rewriting those
 * interactions lost important behavior. The source implementation is copied
 * into ./prototype/PrototypeAudioPlayer.tsx with minimal import substitutions.
 *
 * THIS COMPONENT translates between two distinct persistence models:
 *   Prototype: AudioPlayer(assets, tiers, onSegment, onSelection, ...)
 *   AudioLab v2: { tiers: Record<tierId, segment[]> } in answers[block.id]
 *
 * Selection/zoom/cursor/coverage are LOCAL VIEW STATE: they are not answers.
 * Intervals are controlled by the parent's value/onChange pair so Lesson 9's
 * annotation revisions can persist them. No legacy /api/research calls occur.
 * All positions use SECONDS; coordinates are only translated into seconds
 * by the original prototype player while the user is dragging on screen.
 */
import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import type { Block } from "@/components/task-builder/model";
import { PrototypeAudioPlayer } from "./prototype/PrototypeAudioPlayer";
import { PreferencesProvider } from "./prototype/preferences";
import { commitSegment } from "@/lib/audio/segments";
import { phoneticSummary } from "@/lib/audio/prototype/phonetics";
import {
  readAnnotationFile,
  parseTextGrid,
  writeTextGrid,
} from "@/lib/audio/textgrid";
import { AudioWaveformPlayer } from "./LegacyAudioGroundingEditor";
import "./prototype/prototype-workbench.css";

export { AudioWaveformPlayer };

export type GroundingSegment = {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  /** Semantic link to an interval in parentTierId, not a time constraint. */
  parentId?: string | null;
};
export type GroundingAnswer = { tiers: Record<string, GroundingSegment[]> };
type Tier = NonNullable<Block["tiers"]>[number];

/**
 * Normalize original segments to the new backend's *strict* answer shape.
 * Prototype's objects also contain presentation fields (concept_id,
 * asset_role, etc.). Sending those fields would cause Lesson 9's server-side
 * timeline validator to reject the revision. Strip those UI-only fields here.
 */
function canonical(
  input: GroundingSegment | Record<string, unknown>,
): GroundingSegment {
  const item = input as Record<string, unknown>;
  return {
    id: String(item.id || crypto.randomUUID()),
    start: Number(item.start),
    end: Number(item.end),
    text: String(item.text || ""),
    ...(typeof item.speaker === "string" ? { speaker: item.speaker } : {}),
    ...(typeof item.parentId === "string" || item.parentId === null
      ? { parentId: item.parentId as string | null }
      : typeof item.wordId === "string"
        ? { parentId: item.wordId }
        : {}),
  };
}
/** Infer Sound/Speech from the block, not from which UI happens to be open. */
function modeFor(block: Block): "sound" | "speech" {
  if (block.groundingMode === "sound" || block.groundingMode === "speech")
    return block.groundingMode;
  return (block.tiers ?? []).some((t) => ["words", "phones"].includes(t.id))
    ? "speech"
    : "sound";
}
function configuredTiers(block: Block, mode: "sound" | "speech"): Tier[] {
  const saved = block.tiers ?? [];
  if (saved.length) return saved;
  return mode === "speech"
    ? [
        {
          id: "words",
          name: "Words",
          kind: "interval",
          allowOverlap: true,
          labelMode: "text",
        },
        {
          id: "phones",
          name: "Phones",
          kind: "interval",
          allowOverlap: true,
          labelMode: "ipa",
          parentTierId: "words",
        },
      ]
    : [
        {
          id: "events",
          name: "Sound events",
          kind: "interval",
          allowOverlap: true,
          labelMode: "text",
        },
      ];
}
/**
 * Obtain duration from the selected Task Instance audio, with preview metadata
 * as a fallback. The original AudioPlayer requires a valid duration when
 * it initializes its visible time window, so it mounts only after a finite
 * duration has been found. Never default to an invented 10-second clip.
 */
function useAudioMetadata(url?: string, knownDuration?: number) {
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    setDuration(
      Number.isFinite(knownDuration) && (knownDuration ?? 0) > 0
        ? knownDuration!
        : 0,
    );
    setError("");
    if (!url) return;
    const probe = new Audio();
    probe.preload = "metadata";
    const loaded = () => {
      if (Number.isFinite(probe.duration) && probe.duration > 0)
        setDuration(probe.duration);
    };
    const failed = () =>
      setError(
        "The audio metadata could not be read. Check the asset URL and D1/R2 state.",
      );
    probe.addEventListener("loadedmetadata", loaded);
    probe.addEventListener("error", failed);
    probe.src = url;
    probe.load();
    return () => {
      probe.removeEventListener("loadedmetadata", loaded);
      probe.removeEventListener("error", failed);
      probe.removeAttribute("src");
      probe.load();
    };
  }, [url, knownDuration]);
  return { duration, error };
}
/** Convert a timetable row into a new immutable answer revision. */
function TimingTable({
  label,
  rows,
  parentRows,
  readOnly,
  onEdit,
  onSelect,
}: {
  label: string;
  rows: GroundingSegment[];
  parentRows?: GroundingSegment[];
  readOnly: boolean;
  onEdit: (rows: GroundingSegment[]) => void;
  onSelect: (start: number, end: number) => void;
}) {
  const phones = !!parentRows;
  const change = (id: string, update: Partial<GroundingSegment>) =>
    onEdit(rows.map((s) => (s.id === id ? { ...s, ...update } : s)));
  return (
    <div className="r-table-scroll">
      <table className="r-table r-timing">
        <thead>
          <tr>
            <th>{phones ? "Phone symbol" : "Label / word"}</th>
            {phones && <th>Optional word link</th>}
            <th>Speaker</th>
            <th>Start (s)</th>
            <th>End (s)</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <input
                  aria-label={`${label} label`}
                  disabled={readOnly}
                  value={row.text}
                  onChange={(e) => change(row.id, { text: e.target.value })}
                />
              </td>
              {phones && (
                <td>
                  <select
                    disabled={readOnly}
                    aria-label="Optional word link"
                    value={row.parentId ?? ""}
                    onChange={(e) =>
                      change(row.id, { parentId: e.target.value || null })
                    }
                  >
                    <option value="">Independent phone</option>
                    {parentRows?.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.text}
                      </option>
                    ))}
                  </select>
                </td>
              )}
              <td>
                <input
                  disabled={readOnly}
                  aria-label={`${label} speaker`}
                  value={row.speaker ?? ""}
                  onChange={(e) => change(row.id, { speaker: e.target.value })}
                />
              </td>
              {(["start", "end"] as const).map((key) => (
                <td key={key}>
                  <input
                    type="number"
                    disabled={readOnly}
                    aria-label={`${label} ${key}`}
                    min={0}
                    step={0.001}
                    value={row[key]}
                    onChange={(e) =>
                      change(row.id, { [key]: Number(e.target.value) })
                    }
                  />
                </td>
              ))}
              <td>
                <button
                  type="button"
                  className="button small"
                  onClick={() => onSelect(row.start, row.end)}
                >
                  Select
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    className="button small"
                    onClick={() => onEdit(rows.filter((s) => s.id !== row.id))}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <p className="r-hint">
          Drag on waveform or any tier, label the range and Save segment.
        </p>
      )}
    </div>
  );
}

export default function AudioGroundingEditor({
  block,
  audioUrl,
  value,
  onChange,
  readOnly = false,
  audioMeta,
}: {
  block: Block;
  audioUrl?: string;
  value?: GroundingAnswer;
  onChange: (answer: GroundingAnswer) => void;
  readOnly?: boolean;
  audioMeta?: {
    durationSeconds?: number;
    sampleRate?: number;
    channels?: number;
  };
}) {
  const mode = modeFor(block);
  const flexible = block.groundingMode === "flexible";
  // Selection is local to this recording, while all declared tier answers stay
  // controlled by the workspace. Switching aids never erases saved segments.
  const [aidTier, setAidTier] = useState(block.tiers?.[0]?.id ?? "words");
  const speech = !flexible && mode === "speech";
  const { duration, error } = useAudioMetadata(
    audioUrl,
    audioMeta?.durationSeconds,
  );
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [coverage, setCoverage] = useState<Record<string, number[][]>>({});
  const [showTable, setShowTable] = useState<"words" | "phones" | "events">(
    speech ? "words" : "events",
  );
  const [notice, setNotice] = useState("");
  const current = value ?? { tiers: {} };
  const tiers = configuredTiers(block, mode);
  const phonesTier =
    tiers.find((t) => t.id === "phones")?.id ??
    tiers.find((t) => t.labelMode === "ipa")?.id;
  const wordsTier =
    tiers.find((t) => t.id === "words")?.id ??
    tiers.find((t) => t.labelMode === "text")?.id;
  const words = wordsTier ? (current.tiers[wordsTier] ?? []) : [];
  const phones = phonesTier ? (current.tiers[phonesTier] ?? []) : [];
  const config = {
    alphabet: block.alphabet ?? "IPA",
    level: block.transcriptionLevel ?? "broad",
    symbols: block.phoneticSymbols ?? [],
  };
  // Preview and Labeller receive the same controlled value. No hidden local
  // segment state should survive a reset or a different task assignment.
  useEffect(() => {
    setSelection([0, 0]);
    setCoverage({});
    setNotice("");
    setAidTier(block.tiers?.[0]?.id ?? "words");
  }, [audioUrl, block.id]);
  useEffect(() => {
    setShowTable(speech ? "words" : "events");
  }, [speech]);
  function updateTier(tierId: string, items: GroundingSegment[]) {
    // Keep other tiers untouched; every edit creates one complete immutable
    // answer value for the parent form/annotation revision.
    onChange({
      tiers: {
        ...Object.fromEntries(tiers.map((t) => [t.id, []])),
        ...current.tiers,
        [tierId]: items,
      },
    });
  }
  function saveSegment(
    tierId: string,
    item: Record<string, unknown>,
    linked = false,
  ) {
    try {
      const segment = canonical(item);
      if (!segment.text.trim()) throw new Error("Label cannot be empty.");
      if (!(
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.start >= 0 &&
        segment.start < segment.end &&
        segment.end <= duration + 0.001
      ))
        throw new Error(
          "Interval must lie within the recording and have a positive duration.",
        );
      // Respect the original prototype's option to move adjacent boundaries.
      const old = current.tiers[tierId] ?? [];
      updateTier(tierId, commitSegment(old, segment, linked).map(canonical));
      setNotice(
        "Segment updated in the local draft. Save the assignment to persist it.",
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      // Let the editor retain/reject invalid local edits rather than announce a
      // successful save after adapter validation failed.
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
  function removeSegment(tierId: string, id: string) {
    updateTier(
      tierId,
      (current.tiers[tierId] ?? []).filter((x) => x.id !== id),
    );
  }
  function updateTable(tierId: string, rows: GroundingSegment[]) {
    updateTier(tierId, rows.map(canonical));
  }
  function exportGrid() {
    try {
      const text = writeTextGrid(
        tiers.map((t) => ({ name: t.name, items: current.tiers[t.id] ?? [] })),
        duration,
      );
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      link.download = "audiolab-alignment.TextGrid";
      link.click();
      const url = link.href;
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }
  async function importGrid(e: ChangeEvent<HTMLInputElement>) {
    if (readOnly) return;
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const grid = parseTextGrid(await readAnnotationFile(file));
      if (grid.end > duration + 0.05)
        throw new Error("TextGrid extends beyond the selected audio.");
      const next = { ...current.tiers };
      for (const tier of tiers) {
        const source = grid.tiers.find(
          (t) => t.name === tier.name || t.name === tier.id,
        );
        if (source && source.type === "IntervalTier")
          next[tier.id] = source.items
            .filter((i) => i.text.trim())
            .map((i) => canonical({ ...i, id: crypto.randomUUID() }));
      }
      onChange({ tiers: next });
      setNotice(
        "Imported matching TextGrid tiers. Review annotations before saving.",
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
    e.target.value = "";
  }
  // The original player requires a complete asset object and a finite
  // duration; metadata is intentionally NOT part of a reusable definition.
  if (!audioUrl)
    return (
      <p className="tb-inset">
        Choose an MMAU audio asset in Preview Data to display the workbench.
      </p>
    );
  if (!duration)
    return (
      <p className="tb-inset" role="status">
        {error || "Reading recording duration…"}
      </p>
    );
  const assets = [
    {
      id: audioUrl,
      url: audioUrl,
      role: "scene",
      duration,
      sample_rate: audioMeta?.sampleRate || 16000,
      channels: audioMeta?.channels || 1,
    },
  ];
  const aids = {
    shortcuts: true,
    spectrogram: !!block.aids?.spectrogram,
    pitch: !!block.aids?.pitch,
    energy: !!block.aids?.energy,
    formants: !!block.aids?.formants,
    mfcc: !!block.aids?.mfcc,
  };
  return (
    <div
      className="tb-prototype-shell"
      data-grounding-mode={flexible ? "flexible" : mode}
    >
      {flexible && (
        <label className="tb-field">
          <span>
            Aid segment type for this recording{" "}
            {block.required ? "(answer required)" : "(optional)"}
          </span>
          <select
            value={aidTier}
            onChange={(e) => {
              setAidTier(e.target.value);
              setSelection([0, 0]);
            }}
          >
            {tiers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="r-hint">
        Original prototype interaction · one selection is shared by waveform,
        acoustic plots and all annotation tiers.
      </p>
      <PreferencesProvider>
        <PrototypeAudioPlayer
          key={`${block.id}:${audioUrl}:${mode}:${flexible ? aidTier : "fixed"}`}
          assets={assets}
          role="scene"
          onRole={() => {}}
          selection={selection}
          onSelection={setSelection}
          coverage={coverage}
          onCoverage={(role, ranges) =>
            setCoverage((p) => ({ ...p, [role]: ranges }))
          }
          speech={
            flexible
              ? aidTier === "words" ||
                tiers.find((t) => t.id === aidTier)?.labelMode === "ipa"
              : speech
          }
          precision={block.precisionSeconds ?? 0.01}
          aids={aids}
          tiers={tiers
            .filter((t) => !flexible || t.id === aidTier)
            .map((t) => ({
              id: t.id,
              label: t.name,
              items: current.tiers[t.id] ?? [],
            }))}
          phonetics={config}
          annotation={{
            speakers: block.speakers?.length
              ? block.speakers
              : ["Speaker 1", "Speaker 2"],
            sound_concepts:
              block.soundConcepts?.map((x) => ({ id: x.id, label: x.label })) ??
              [],
            lane_layout: block.laneLayout ?? "overlap",
          }}
          onSegment={readOnly ? undefined : saveSegment}
          onSegmentDelete={readOnly ? undefined : removeSegment}
        />
      </PreferencesProvider>
      <div className="r-prototype-tables">
        <div className="r-row r-prototype-tables-top">
          <b>Timed annotation table</b>
          <span className="r-hint">
            Exact second boundaries · select a row to synchronize the entire
            workbench.
          </span>
        </div>
        <div className="r-tabs" role="tablist">
          {(speech
            ? ([
                { key: "words", label: `Words (${words.length})` },
                { key: "phones", label: `Phones (${phones.length})` },
              ] as const)
            : ([
                {
                  key: "events",
                  label: `${flexible ? "All segments" : "Sound events"} (${Object.values(current.tiers).flat().length})`,
                },
              ] as const)
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={showTable === t.key}
              className={showTable === t.key ? "active" : ""}
              onClick={() => setShowTable(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {speech ? (
          <TimingTable
            label={showTable === "phones" ? "Phone" : "Word"}
            rows={showTable === "phones" ? phones : words}
            parentRows={showTable === "phones" ? words : undefined}
            readOnly={readOnly}
            onSelect={(start, end) => setSelection([start, end])}
            onEdit={(rows) =>
              updateTable(
                showTable === "phones" ? phonesTier! : wordsTier!,
                rows,
              )
            }
          />
        ) : (
          tiers.map((t) => (
            <div key={t.id} className="r-prototype-table-tier">
              <h4>{t.name}</h4>
              <TimingTable
                label={t.name}
                rows={current.tiers[t.id] ?? []}
                readOnly={readOnly}
                onEdit={(rows) => updateTable(t.id, rows)}
                onSelect={(start, end) => setSelection([start, end])}
              />
            </div>
          ))
        )}
        {speech && (
          <div className="r-prototype-summaries">
            <section>
              <b>Current words</b>
              <p>
                {words.length
                  ? [...words]
                      .sort((a, b) => a.start - b.start)
                      .map((s) => s.text)
                      .join(" ")
                  : "No words yet."}
              </p>
            </section>
            <section>
              <b>Current phones</b>
              <p>
                {phones.length
                  ? phoneticSummary(phones, config)
                  : "No phones yet."}
              </p>
            </section>
          </div>
        )}
        {!readOnly && (
          <div className="r-row r-prototype-io">
            <button className="button small" type="button" onClick={exportGrid}>
              Export TextGrid
            </button>
            <label className="button small">
              Import TextGrid{" "}
              <input
                type="file"
                accept=".TextGrid,.textgrid,text/plain"
                onChange={(e) => void importGrid(e)}
              />
            </label>
          </div>
        )}
        {notice && (
          <p className="r-hint" role="status">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
