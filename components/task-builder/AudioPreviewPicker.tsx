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

type CandidateResponse = {
  candidates: Array<{
    id: string;
    label: string;
  }>;
};

function isCandidateResponse(value: unknown): value is CandidateResponse {
  if (typeof value !== "object" || value === null || !("candidates" in value)) {
    return false;
  }

  return (
    Array.isArray(value.candidates) &&
    value.candidates.every(
      (candidate: unknown) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "id" in candidate &&
        typeof candidate.id === "string" &&
        "label" in candidate &&
        typeof candidate.label === "string",
    )
  );
}

export default function AudioPreviewPicker({
  projectId,
  slots,
  batchCount = 1,
  onChange,
}: {
  projectId: string;
  slots: string[];
  batchCount?: number;
  onChange: (samples: Samples) => void;
}) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [assets, setAssets] = useState<AudioAsset[]>([]);
  const [selected, setSelected] = useState("");
  const [bindings, setBindings] = useState<Record<string, string>>({});
  /** One stable asset selection per batch position. Empty slots auto-select
   * distinct WAVs from the chosen dataset, never store these IDs in draft. */
  const [batchBindings, setBatchBindings] = useState<Record<number, string>>(
    {},
  );
  const [candidates, setCandidates] = useState<
    Array<{ id: string; label: string }>
  >([]);
  const [candidateId, setCandidateId] = useState("");
  const [error, setError] = useState("");
  // Preserve a stable identity for slots even if two blocks use the same
  // human-readable slot name. Shared names refer to the same preview audio.
  const slotsKey = JSON.stringify(slots);
  // This key prevents an infinite effect when TaskBuilder creates a new array
  // containing the same slot names during a routine React render.
  const uniqueSlots = useMemo(
    () => [...new Set((JSON.parse(slotsKey) as string[]).filter(Boolean))],
    [slotsKey],
  );
  useEffect(() => {
    const controller = new AbortController();
    setDatasets([]);
    setDatasetId("");
    setAssets([]);
    setSelected("");
    setBindings({});
    setBatchBindings({});
    setBatchBindings({});
    setError("");
    if (!projectId) return;
    fetch(`/api/v1/datasets?projectId=${encodeURIComponent(projectId)}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Dataset HTTP ${r.status}`);
        return r.json() as Promise<{ datasets: Dataset[] }>;
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setDatasets(data.datasets);
          setDatasetId(data.datasets[0]?.id || "");
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(String(err));
      });
    return () => controller.abort();
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    setAssets([]);
    setSelected("");
    setBindings({});
    setBatchBindings({});
    if (!datasetId) return;
    fetch(`/api/v1/assets?datasetId=${encodeURIComponent(datasetId)}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Asset HTTP ${r.status}`);
        return r.json() as Promise<{ assets: AudioAsset[] }>;
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setAssets(data.assets);
          setSelected(data.assets[0]?.id || "");
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(String(err));
      });
    return () => controller.abort();
  }, [datasetId]);
  useEffect(() => {
    const ctrl = new AbortController();
    setCandidates([]);
    setCandidateId("");
    if (!selected) return;
    fetch(
      `/api/v1/annotation-candidates?assetId=${encodeURIComponent(selected)}`,
      { signal: ctrl.signal },
    )
      .then((r) =>
        r.ok
          ? r.json()
          : Promise.reject(new Error(`Candidate HTTP ${r.status}`)),
      )
      .then((data: unknown) => {
        if (!isCandidateResponse(data)) {
          throw new Error("Invalid candidate response");
        }
        if (!ctrl.signal.aborted) {
          setCandidates(data.candidates);
          setCandidateId(data.candidates[0]?.id ?? "");
        }
      })
      .catch(() => {
        /* Candidate API is optional until migration 0008 is applied. */
      });
    return () => ctrl.abort();
  }, [selected]);
  useEffect(() => {
    const toUrl = (id: string) =>
      id ? `/api/v1/assets/${encodeURIComponent(id)}/audio` : undefined;
    const audio: Record<string, string> = {};
    for (const slot of uniqueSlots) {
      const url = toUrl(bindings[slot] || selected);
      if (url) audio[slot] = url;
    }
    const chosen = assets.find((a) => a.id === selected);
    const batchAudio = Array.from(
      { length: Math.max(1, Math.min(24, batchCount)) },
      (_, i) => {
        const match = assets.find(
          (a) =>
            a.id === (batchBindings[i] || (i === 0 ? selected : assets[i]?.id)),
        );
        return match
          ? { id: match.id, url: toUrl(match.id)!, label: match.originalPath }
          : { id: "", url: "", label: `Missing recording ${i + 1}` };
      },
    );
    const chosenCandidate = candidates.find((c) => c.id === candidateId);
    onChange({
      primaryUrl: toUrl(selected),
      audio,
      batchAudio,
      candidateId: chosenCandidate?.id,
      candidateText: chosenCandidate?.label,
      primaryMeta: chosen
        ? {
            durationSeconds: chosen.durationSeconds,
            sampleRate: chosen.sampleRate,
            channels: chosen.channels,
          }
        : undefined,
    });
    // onChange is a state-setter from TaskBuilder. Do not depend on a changing
    // callback identity, or the effect could render infinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selected,
    bindings,
    batchBindings,
    batchCount,
    uniqueSlots,
    assets,
    candidates,
    candidateId,
  ]);
  return (
    <section className="tb-panel tb-preview-source">
      <p className="tb-eyebrow">PREVIEW DATA / NOT SAVED IN TASK DEFINITION</p>
      <h3>Test using an existing audio asset</h3>
      <p className="tb-muted">
        Select a dataset and one MMAU WAV to hear how the real Labeller will
        experience this task.
      </p>
      <div className="tb-grid tb-wide">
        <label className="tb-field">
          <span>Dataset</span>
          <select
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
          >
            <option value="">No dataset</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.version}
              </option>
            ))}
          </select>
        </label>
        <label className="tb-field">
          <span>Primary recording</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">No audio available</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.originalPath}
              </option>
            ))}
          </select>
        </label>
      </div>
      {candidates.length > 0 && (
        <label className="tb-field">
          <span>Curated candidate for Candidate Vote</span>
          <select
            value={candidateId}
            onChange={(e) => setCandidateId(e.target.value)}
          >
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {batchCount > 1 && (
        <details className="tb-detail" open>
          <summary>NUM_BATCH · Assign {batchCount} preview recordings</summary>
          {assets.length < batchCount && (
            <p className="tb-notice bad">
              This dataset has only {assets.length} assets; select a dataset
              with {batchCount} recordings.
            </p>
          )}
          <div className="tb-grid tb-wide">
            {Array.from({ length: Math.min(batchCount, 24) }, (_, i) => (
              <label className="tb-field" key={i}>
                <span>Audio #{i + 1}</span>
                <select
                  value={
                    batchBindings[i] ||
                    (i === 0 ? selected : (assets[i]?.id ?? ""))
                  }
                  onChange={(e) =>
                    setBatchBindings((prev) => ({
                      ...prev,
                      [i]: e.target.value,
                    }))
                  }
                >
                  <option value="">Choose recording</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.originalPath}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </details>
      )}
      {uniqueSlots.length > 0 && (
        <details className="tb-detail">
          <summary>Map comparison/ranking slots to preview audio</summary>
          <p className="tb-muted">
            These selections affect preview only. The Task Instance API binds
            the actual assets; never store their URLs in reusable definitions.
          </p>
          <div className="tb-grid tb-wide">
            {uniqueSlots.map((slot) => (
              <label className="tb-field" key={slot}>
                <span>{slot}</span>
                <select
                  value={bindings[slot] || selected}
                  onChange={(e) =>
                    setBindings((prev) => ({ ...prev, [slot]: e.target.value }))
                  }
                >
                  <option value="">No recording</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.originalPath}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </details>
      )}
      {error && (
        <p className="tb-notice bad" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
