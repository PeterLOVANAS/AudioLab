"use client";
import { useEffect, useState } from "react";
import type {
  SourceFieldPayload,
  WorkerSourcePayload,
  SourcePreviewPayload,
} from "@/lib/contracts/source-fields";

import {
  loadSourcePreviewBatch,
  type PreviewSlot,
  type PreviewRecord,
} from "@/lib/frontend/source-preview";

type Dataset = { id: string; name: string };
type Asset = { id: string; originalPath: string };
type RecordRow = PreviewRecord;

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(
      payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
        ? payload.error
        : `Sample unavailable (HTTP ${response.status}).`,
    );
  }
  return response.json() as Promise<T>;
}

/** Load project-scoped authoring samples through the existing T01 source adapter. */
export default function SourceSamplePicker({
  projectId,
  onChange,
  batchCount = 1,
  onBatchChange,
}: {
  projectId: string;
  onChange: (sample: SourcePreviewPayload | null) => void;
  batchCount?: number;
  onBatchChange?: (samples: SourcePreviewPayload[]) => void;
}) {
  const [memberId, setMemberId] = useState("");
  const [members, setMembers] = useState<
    Array<{ userId: string; displayName: string; role: string }>
  >([]);
  const selectedMember = members.find((m) => m.userId === memberId);
  const access = selectedMember?.role === "admin" ? "admin" : "worker";
  useEffect(() => {
    const controller = new AbortController();
    setMembers([]);
    setMemberId("");
    if (projectId)
      read<{
        members: Array<{ userId: string; displayName: string; role: string }>;
      }>(
        `project-members?projectId=${encodeURIComponent(projectId)}`,
        controller.signal,
      )
        .then(async ({ members }) => {
          const identity = await read<{ user: { userId: string } | null }>(
            "auth/session",
            controller.signal,
          );
          if (!controller.signal.aborted) {
            const eligible = members.filter(
              (m) =>
                ["labeller", "admin"].includes(m.role) &&
                m.userId === identity.user?.userId,
            );
            setMembers(eligible);
            setMemberId(
              eligible.find((m) => m.role === "labeller")?.userId ??
                eligible[0]?.userId ??
                "",
            );
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError("Cannot load local preview members");
        });
    return () => controller.abort();
  }, [projectId]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState("");
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [recordId, setRecordId] = useState("");
  const [error, setError] = useState("");
  // Extra item choices belong to preview state, never the reusable definition.
  const [batchSlots, setBatchSlots] = useState<PreviewSlot[]>([]);
  const [selectedRecords, setSelectedRecords] = useState<
    Record<string, string>
  >({});
  const [batchError, setBatchError] = useState("");
  const [batchLoading, setBatchLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setDatasets([]);
    setDatasetId("");
    if (projectId)
      read<{ datasets: Dataset[] }>(
        `datasets?projectId=${encodeURIComponent(projectId)}`,
        controller.signal,
      )
        .then(({ datasets: rows }) => {
          if (!controller.signal.aborted) {
            setDatasets(rows);
            setDatasetId(rows[0]?.id ?? "");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError("Cannot load project datasets.");
        });
    return () => controller.abort();
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    setAssets([]);
    setAssetId("");
    setRecords([]);
    setRecordId("");
    onChange(null);
    if (datasetId)
      read<{ assets: Asset[] }>(
        `assets?datasetId=${encodeURIComponent(datasetId)}`,
        controller.signal,
      )
        .then(({ assets: rows }) => {
          if (!controller.signal.aborted) {
            setAssets(rows);
            setAssetId(rows[0]?.id ?? "");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError("Cannot load dataset recordings.");
        });
    return () => controller.abort();
  }, [datasetId, onChange]);
  useEffect(() => {
    const controller = new AbortController();
    setRecords([]);
    setRecordId("");
    onChange(null);
    if (assetId)
      read<{ sourceRecords: RecordRow[] }>(
        `source-records?assetId=${encodeURIComponent(assetId)}`,
        controller.signal,
      )
        .then(({ sourceRecords: rows }) => {
          if (!controller.signal.aborted) {
            setRecords(rows);
            setRecordId(rows[0]?.sourceRecordId ?? "");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError("No source records for this recording.");
        });
    return () => controller.abort();
  }, [assetId, onChange]);
  // This effect owns the selected source sample, never the Task Definition.
  // Include assetId in both the request and dependencies: external record IDs
  // can repeat on different recordings. Abort prevents a slower old selection
  // from replacing the new sample; runtime assignment resolution pins these fields separately.
  useEffect(() => {
    const controller = new AbortController();
    onChange(null);
    setError("");
    if (projectId && datasetId && assetId && recordId && memberId) {
      const query = new URLSearchParams({
        projectId,
        datasetId,
        assetId,
        recordId,
        userId: memberId,
        view: access,
      });
      read<{ source: SourceFieldPayload | WorkerSourcePayload }>(
        `source-fields?${query}`,
        controller.signal,
      )
        .then(({ source }) => {
          if (!controller.signal.aborted)
            onChange({
              projectId,
              datasetId,
              recordId,
              audio: { assetId, url: `/api/v1/assets/${assetId}/audio` },
              audioUrl: `/api/v1/assets/${assetId}/audio`,
              fields: source.fields,
              access,
            });
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setError(
              reason instanceof Error ? reason.message : "Sample unavailable.",
            );
        });
    }
    return () => controller.abort();
  }, [projectId, datasetId, assetId, recordId, memberId, access, onChange]);
  // One authoritative source-field request per selected recording/item pair.
  // Changing any slot cancels the old batch and clears rendered bound answers.
  useEffect(() => {
    const controller = new AbortController();
    onBatchChange?.([]);
    setBatchSlots([]);
    setBatchError("");
    setBatchLoading(false);
    if (batchCount > 1 && projectId && datasetId && memberId && assetId) {
      setBatchLoading(true);
      loadSourcePreviewBatch(
        {
          projectId,
          datasetId,
          memberId,
          access,
          assets,
          assetId,
          recordId,
          count: batchCount,
          selectedRecords,
        },
        read,
        controller.signal,
      )
        .then(({ samples, slots }) => {
          if (!controller.signal.aborted) {
            setBatchSlots(slots);
            onBatchChange?.(samples);
          }
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setBatchError(
              reason instanceof Error
                ? reason.message
                : "Batch sample unavailable.",
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setBatchLoading(false);
        });
    }
    return () => controller.abort();
  }, [
    batchCount,
    memberId,
    assetId,
    recordId,
    projectId,
    datasetId,
    access,
    assets,
    selectedRecords,
    onBatchChange,
  ]);
  return (
    <section
      className="tb-panel tb-source-sample"
      aria-label="Dataset sample preview"
    >
      <h3>Dataset sample for bound fields</h3>
      <p className="tb-muted">
        Select a source record. For batches, preview uses this recording and the
        next distinct recordings. Each extra recording defaults to its first
        source item; use the selectors below to choose another question.
        Recordless audio remains usable for manual audio comparisons. Samples
        stay out of the saved definition. Preview identity is local development
        only; protected labels require admin access.
      </p>
      <div className="tb-grid">
        <label className="tb-field">
          <span>Local preview member</span>
          <select
            value={memberId}
            onChange={(event) => setMemberId(event.target.value)}
          >
            <option value="">Choose member</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName} ({m.role})
              </option>
            ))}
          </select>
        </label>
        <label className="tb-field">
          <span>Dataset</span>
          <select
            value={datasetId}
            onChange={(event) => setDatasetId(event.target.value)}
          >
            <option value="">Choose dataset</option>
            {datasets.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label className="tb-field">
          <span>Recording</span>
          <select
            value={assetId}
            onChange={(event) => setAssetId(event.target.value)}
          >
            <option value="">Choose recording</option>
            {assets.map((row) => (
              <option key={row.id} value={row.id}>
                {row.originalPath}
              </option>
            ))}
          </select>
        </label>
        <label className="tb-field">
          <span>Source record</span>
          <select
            value={recordId}
            onChange={(event) => setRecordId(event.target.value)}
          >
            <option value="">Choose record</option>
            {records.map((row) => (
              <option key={row.sourceRecordId} value={row.sourceRecordId}>
                {row.sourceRecordId}
              </option>
            ))}
          </select>
        </label>
      </div>
      {batchLoading && (
        <p className="tb-muted" role="status">
          Loading recording/item preview…
        </p>
      )}
      {batchSlots.length > 1 && (
        <fieldset className="tb-settings">
          <legend>Batch preview source items</legend>
          {batchSlots.slice(1).map((slot, index) => (
            <label className="tb-field" key={slot.assetId}>
              <span>
                Recording {index + 2}: {slot.label}
              </span>
              {slot.records.length ? (
                <select
                  value={slot.recordId}
                  onChange={(event) =>
                    setSelectedRecords((current) => ({
                      ...current,
                      [slot.assetId]: event.target.value,
                    }))
                  }
                >
                  {slot.records.map((record) => (
                    <option
                      key={record.sourceRecordId}
                      value={record.sourceRecordId}
                    >
                      {record.question
                        ? `${record.sourceRecordId} — ${record.question.slice(0, 100)}`
                        : record.sourceRecordId}
                    </option>
                  ))}
                </select>
              ) : (
                <small>Audio only — no source items or bound fields.</small>
              )}
            </label>
          ))}
        </fieldset>
      )}
      {batchError && (
        <p role="alert" className="tb-notice bad">
          {batchError}
        </p>
      )}
      {error && (
        <p role="alert" className="tb-notice bad">
          {error}
        </p>
      )}
    </section>
  );
}
