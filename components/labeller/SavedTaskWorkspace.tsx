"use client";

/**
 * AudioLab 2.0 — Labeller view of DB-SAVED Task Builder V4 definitions.
 *
 * WHY: Saving a definition writes task_definitions, NOT assignments. A queue
 * containing only assignments therefore appears empty. This component lets
 * labellers open saved DB definitions immediately using the exact Builder
 * preview renderer and sample-audio picker.
 *
 * TWO DISTINCT OPERATIONS:
 *  1. Try saved definition: zero backend writes; answers are deliberately local.
 *  2. Start REAL test annotation: explicit user action for a PUBLISHED version;
 *     creates a task instance + assignment using the existing APIs, then moves
 *     to the persisted annotation queue. No new assignment-management page.
 *
 * DEVELOPMENT ONLY: current APIs accept labellerId from the browser. Never
 * expose the test-run creation flow publicly without real authorization.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import AudioPreviewPicker from "@/components/task-builder/AudioPreviewPicker";
import WorkbenchLayout from "@/components/workbench/WorkbenchLayout";
import BlockFields, {
  checkAnswers,
  type Answers,
  type Samples,
} from "@/components/workbench/BlockFields";
import {
  readBlock,
  type Block,
  type Draft,
} from "@/components/task-builder/model";

type DefinitionListRow = {
  id: string;
  name: string;
  draftRevision: number;
  publishedVersion: number;
};
type SavedDefinition = {
  id: string;
  draftRevision: number;
  publishedVersion: number;
  draft: Draft;
};

type ApiFailure = Error & { status?: number };
async function jsonApi<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/v1/${path}`, {
    credentials: "same-origin",
    cache: "no-store", // the Builder's draft may have changed since last visit
    ...options,
    headers,
  });
  const payload: unknown = await response.json().catch(() => null);
  const body =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (!response.ok) {
    const err: ApiFailure = new Error(
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
    );
    err.status = response.status;
    throw err;
  }
  return payload as T;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed";

/**
 * Same rule as Builder's previewBatchCount: the definition describes how many
 * ordered recordings a task needs; queue prefetch count is an unrelated knob.
 */
function audioRequirements(blocks: Block[]) {
  return Math.min(
    24,
    Math.max(
      1,
      ...blocks.map((b) =>
        b.type === "ranking" && b.rankingMode !== "labels"
          ? Math.max(b.numBatch ?? 1, b.stimulusSlots?.length ?? 1)
          : (b.numBatch ?? 1),
      ),
    ),
  );
}

export default function SavedTaskWorkspace({
  projectId,
  labellerId,
  onAssigned,
}: {
  projectId: string;
  labellerId: string;
  onAssigned: () => void;
}) {
  const [rows, setRows] = useState<DefinitionListRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selected, setSelected] = useState<SavedDefinition | null>(null);
  const [samples, setSamples] = useState<Samples>({});
  // Do not enumerate an entire dataset while merely browsing saved templates.
  const [audioPickerOpen, setAudioPickerOpen] = useState(false);
  const [answers, setAnswers] = useState<Answers>({});
  const [triedValidation, setTriedValidation] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDefinition, setLoadingDefinition] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setSelectedId("");
    setSelected(null);
    setError("");
    setLoadingList(true);
    if (!projectId) {
      setLoadingList(false);
      return () => controller.abort();
    }
    jsonApi<{ definitions: DefinitionListRow[] }>(
      `task-definitions?projectId=${encodeURIComponent(projectId)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        const next = result.definitions ?? [];
        setRows(next);
        setSelectedId(next[0]?.id ?? "");
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorText(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingList(false);
      });
    return () => controller.abort();
  }, [projectId, reload]);

  useEffect(() => {
    const controller = new AbortController();
    setSelected(null);
    setAnswers({});
    setTriedValidation(false);
    setSamples({});
    setAudioPickerOpen(false);
    setNotice("");
    setError("");
    if (!selectedId) {
      setLoadingDefinition(false);
      return () => controller.abort();
    }
    setLoadingDefinition(true);
    jsonApi<{ taskDefinition: SavedDefinition }>(
      `task-definitions/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setSelected(result.taskDefinition);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorText(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDefinition(false);
      });
    return () => controller.abort();
  }, [selectedId, reload]);

  const blocks = useMemo(() => {
    const raw = selected?.draft.blocks;
    return Array.isArray(raw) ? raw.map((block) => readBlock(block)) : [];
  }, [selected]);
  const previewBatchCount = useMemo(() => audioRequirements(blocks), [blocks]);
  const previewSlots = useMemo(
    () =>
      blocks.flatMap((block) => [
        ...(block.stimulusSlots ?? []),
        ...(block.stimulusSlot ? [block.stimulusSlot] : []),
      ]),
    [blocks],
  );
  const issues = triedValidation ? checkAnswers(blocks, answers) : [];
  const updateSamples = useCallback((next: Samples) => setSamples(next), []);

  function choose(id: string) {
    if (id === selectedId) return;
    if (
      Object.keys(answers).length &&
      !window.confirm("Discard test answers and open a different saved task?")
    )
      return;
    setSelectedId(id);
  }

  /**
   * Deliberately no hidden creation on Save or on role switch. When the tester
   * presses this button, we bind the selected WAV IDs to a frozen version and
   * create a real assignment using the EXISTING APIs. All other labeller work
   * continues through the persisted queue, with server revision control.
   */
  async function createTestRun() {
    if (
      !selected ||
      selected.publishedVersion < 1 ||
      !projectId ||
      !labellerId ||
      creating
    )
      return;
    const chosen = (samples.batchAudio ?? []).slice(0, previewBatchCount);
    if (
      chosen.length !== previewBatchCount ||
      chosen.some((item) => !item.id)
    ) {
      setError(
        `Select ${previewBatchCount} recording(s) before starting a test run.`,
      );
      return;
    }
    const ids = chosen.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      setError(
        "A real batch must contain different recordings. Change the duplicate selections above.",
      );
      return;
    }
    // A draft may be newer than its published version. Never pretend that
    // the unsaved/unpublished appearance is the frozen version being assigned.
    if (
      !window.confirm(
        `Create one REAL test assignment for ${labellerId} using published version ${selected.publishedVersion}? ` +
          "This saves an instance and assignment in D1. The latest editable draft may be different.",
      )
    )
      return;
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const created = await jsonApi<{ taskInstance: { id: string } }>(
        "task-instances",
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            definitionId: selected.id,
            definitionVersion: selected.publishedVersion,
            assetId: ids[0],
            ...(ids.length > 1 ? { audioAssetIds: ids } : {}),
          }),
        },
      );
      await jsonApi("assignments", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          taskInstanceId: created.taskInstance.id,
          labellerId,
        }),
      });
      setNotice("Test assignment created. Opening the real annotation queue…");
      onAssigned();
    } catch (err) {
      setError(
        errorText(err) +
          ". If this instance already exists, use the Assigned queue or select another audio recording.",
      );
    } finally {
      setCreating(false);
    }
  }

  if (!projectId)
    return (
      <div className="alw-empty">
        <h2>Choose a project</h2>
        <p>
          Include a projectId in the workspace URL to load saved Task Builder
          definitions.
        </p>
      </div>
    );

  return (
    <div className="tb-preview-workspace" style={{ padding: "1rem" }}>
      <div
        className="tb-panel"
        style={{ marginBottom: "1rem", padding: "1rem" }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "1rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div>
            <p className="tb-eyebrow">SAVED TASK DEFINITIONS · DATABASE</p>
            <h1>Try a Builder task as a Labeller</h1>
            <p>
              Saved templates appear here immediately. This view reuses the
              exact V4 Builder preview controls.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setReload((v) => v + 1)}
            disabled={loadingList || creating}
          >
            Refresh saved tasks
          </button>
        </div>
        <p className="tb-notice">
          Test answers here are temporary, not submitted to D1. To save real
          annotation revisions, publish the definition and use{" "}
          <strong>Start real test assignment</strong> below. The separate Admin
          assignment page remains your teammate's responsibility.
        </p>
        {error && (
          <p role="alert" className="tb-notice bad">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="tb-notice ok">
            {notice}
          </p>
        )}
      </div>
      {selected && (
        <section
          className="tb-panel"
          style={{ marginBottom: "0.75rem", padding: "0.75rem" }}
        >
          <button
            type="button"
            onClick={() => setAudioPickerOpen((open) => !open)}
          >
            {audioPickerOpen ? "Hide audio selector" : "Attach sample audio"}
          </button>
          <small style={{ marginLeft: "0.75rem" }}>
            Audio metadata is fetched only after you open the selector.
          </small>
        </section>
      )}
      {selected && audioPickerOpen && (
        <AudioPreviewPicker
          key={`${selected.id}:${previewBatchCount}`}
          projectId={projectId}
          slots={previewSlots}
          batchCount={previewBatchCount}
          onChange={updateSamples}
        />
      )}
      <WorkbenchLayout
        name={selected?.draft.name ?? "Saved Task Definitions"}
        instructions={
          selected?.draft.instructions ?? "Choose a saved task from the list."
        }
        queue={
          <>
            <p className="tb-eyebrow">SAVED IN D1</p>
            <h2>Builder tasks</h2>
            {loadingList && <p>Loading saved definitions…</p>}
            {!loadingList && !rows.length && (
              <p>
                No saved definitions in this project. Save a Task Builder draft
                first.
              </p>
            )}
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => choose(row.id)}
                  aria-current={row.id === selectedId ? "true" : undefined}
                  style={{
                    textAlign: "left",
                    padding: "0.65rem",
                    borderRadius: "0.5rem",
                    border:
                      row.id === selectedId
                        ? "2px solid currentColor"
                        : "1px solid #9995",
                    background: "transparent",
                  }}
                >
                  <strong>{row.name || "Untitled task"}</strong>
                  <small style={{ display: "block" }}>
                    Saved rev {row.draftRevision} ·{" "}
                    {row.publishedVersion
                      ? `Published v${row.publishedVersion}`
                      : "Draft only"}
                  </small>
                </button>
              ))}
            </div>
          </>
        }
        grounding={
          selected &&
          !blocks.some((block) => block.type === "timeline_annotation") ? (
            <section className="tb-panel tb-preview-player">
              <p className="tb-eyebrow">02 / AUDIO STIMULUS</p>
              <h3>Primary recording</h3>
              {samples.primaryUrl ? (
                <audio
                  controls
                  src={samples.primaryUrl}
                  preload="metadata"
                  aria-label="Selected recording"
                />
              ) : (
                <p className="tb-muted">Select an audio recording above.</p>
              )}
            </section>
          ) : null
        }
      >
        {loadingDefinition ? (
          <p>Loading saved definition…</p>
        ) : selected ? (
          <>
            <p className="tb-preview-caption">
              Source: Task Builder draft revision {selected.draftRevision};
              saved in D1.
            </p>
            {blocks.length ? (
              <BlockFields
                key={selected.id}
                blocks={blocks}
                answers={answers}
                onChange={setAnswers}
                samples={samples}
                allowLocalAudio
              />
            ) : (
              <p>No blocks in this saved task.</p>
            )}
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                flexWrap: "wrap",
                marginTop: "1rem",
              }}
            >
              <button type="button" onClick={() => setTriedValidation(true)}>
                Check answers
              </button>
              <button
                type="button"
                onClick={() => {
                  setAnswers({});
                  setTriedValidation(false);
                }}
              >
                Reset answers
              </button>
              <button
                type="button"
                onClick={() => void createTestRun()}
                disabled={
                  creating ||
                  selected.publishedVersion < 1 ||
                  !labellerId ||
                  !samples.primaryUrl
                }
              >
                {creating
                  ? "Creating test assignment…"
                  : "Start real test assignment"}
              </button>
            </div>
            {selected.publishedVersion < 1 && (
              <p className="tb-muted">
                Publish this definition in Task Builder before creating a real
                annotation. Saving a draft alone does not freeze a version.
              </p>
            )}
            {triedValidation && (
              <div
                className={`tb-notice ${issues.length ? "bad" : "ok"}`}
                role="status"
              >
                {issues.length ? (
                  <ul>
                    {issues.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  "Test answers complete (not saved to D1)."
                )}
              </div>
            )}
          </>
        ) : (
          <p>Select a saved Builder task.</p>
        )}
      </WorkbenchLayout>
      <p className="alw-warning">
        DEV ONLY: test-run creation uses the current unauthenticated
        project/member APIs. Do not deploy publicly.
      </p>
    </div>
  );
}
