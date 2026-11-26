"use client";

import { startingAssignmentAnswers } from "@/lib/frontend/source-binding";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BlockFields, {
  checkAnswers,
  type Answers,
} from "@/components/workbench/BlockFields";
import type { Block } from "@/components/task-builder/model";
import type { AssignmentSummary } from "@/lib/contracts/assignment-api";
import {
  ApiError,
  getAssignmentDetail,
  withCandidateSets,
  getCurrentAnnotation,
  getQueuePage,
  startAssignment,
  writeAnnotation,
  type AssignmentDetail,
} from "@/lib/frontend/labeller-api";
import { toLabellerSamples } from "@/lib/frontend/labeller-samples";

type SaveState =
  "loading" | "saved" | "dirty" | "saving" | "error" | "conflict" | "submitted";
const fingerprint = (value: Answers) => JSON.stringify(value);
function messageOf(error: unknown) {
  return error instanceof Error
    ? error.message
    : "An unexpected error occurred.";
}
function validationMessages(error: unknown): string[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.issues)) return [];
  return error.issues.slice(0, 30).map((issue: unknown) => {
    if (!issue || typeof issue !== "object")
      return "Invalid annotation answer.";
    const data = issue as Record<string, unknown>;
    const label = typeof data.blockId === "string" ? data.blockId : "Answer";
    return `${label}: ${typeof data.message === "string" ? data.message : "Invalid value."}`;
  });
}

export default function LabellerWorkspace({
  projectId,
  labellerId,
}: {
  projectId: string;
  labellerId: string;
}) {
  const [queue, setQueue] = useState<AssignmentSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);
  const [jsonLoadMs, setJsonLoadMs] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [feedback, setFeedback] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Mutable refs are essential for asynchronous saves: don't write a stale
  // render's answers or expectedRevision after another save has completed.
  const activeRef = useRef<string | null>(null);
  const answersRef = useRef<Answers>({});
  const revisionRef = useRef(0);
  const savedStampRef = useRef(fingerprint({}));
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const submittingRef = useRef(false);
  const prefetchCache = useRef<Map<string, AssignmentDetail>>(new Map());

  // Closing a ballot is not a submitted annotation for non-voters. Keep their
  // real status/history and make this terminal job read-only without fake saves.
  const votingClosed = Object.values(
    detail?.taskInstance.candidateSets ?? {},
  ).some((set) => set.closed);
  const votingClosedRef = useRef(false);
  votingClosedRef.current = votingClosed;
  const isDirty =
    !votingClosed && fingerprint(answers) !== savedStampRef.current;
  const blocks = useMemo(() => {
    const raw: unknown = detail?.taskInstance.resolvedDefinition?.blocks ?? detail?.taskInstance.definition.blocks;
    // Task Definition validation lives on the backend. This sanity check
    // catches malformed API payloads before rendering them as V4 blocks.
    if (
      !Array.isArray(raw) ||
      !raw.every(
        (b) =>
          b &&
          typeof b === "object" &&
          typeof b.id === "string" &&
          typeof b.type === "string" &&
          typeof b.label === "string",
      )
    )
      return [];
    return raw as Block[];
  }, [detail]);
  const samples = useMemo(
    () => (detail ? toLabellerSamples(detail.taskInstance, blocks) : undefined),
    [detail, blocks],
  );
  const index = queue.findIndex((row) => row.id === activeId);
  const selected = index < 0 ? undefined : queue[index];

  const loadPage = useCallback(
    async (cursor?: string) => {
      if (!projectId || !labellerId) return;
      setQueueLoading(true);
      setQueueError("");
      try {
        const result = await getQueuePage(projectId, labellerId, cursor);
        setQueue((previous) =>
          cursor
            ? [
                ...previous,
                ...result.assignments.filter(
                  (row) => !previous.some((prev) => prev.id === row.id),
                ),
              ]
            : result.assignments,
        );
        setNextCursor(result.nextCursor);
        if (!cursor)
          setActiveId((old) => old ?? result.assignments[0]?.id ?? null);
      } catch (error) {
        setQueueError(messageOf(error));
      } finally {
        setQueueLoading(false);
      }
    },
    [projectId, labellerId],
  );

  useEffect(() => {
    if (!projectId || !labellerId) return;
    setQueue([]);
    setNextCursor(null);
    setActiveId(null);
    prefetchCache.current.clear();
    void loadPage();
  }, [projectId, labellerId, loadPage]);

  useEffect(() => {
    activeRef.current = activeId;
    if (!activeId) {
      setDetail(null);
      setLoadingTask(false);
      setSaveState("saved");
      return;
    }
    const controller = new AbortController();
    // Identity switches invalidate the previous editor before any fetch.
    setDetail(null);
    setLoadingTask(true);
    setJsonLoadMs(null);
    setFeedback("");
    setIssues([]);
    setSaveState("loading");
    const fetchStart = performance.now();
    const cached = prefetchCache.current.get(activeId);
    prefetchCache.current.delete(activeId);
    const detailPromise = cached
      ? Promise.resolve(cached)
      : getAssignmentDetail(activeId, controller.signal);
    Promise.all([
      detailPromise.then((detail) =>
        withCandidateSets(detail, labellerId, controller.signal),
      ),
      getCurrentAnnotation(activeId, labellerId, controller.signal),
    ])
      .then(([loaded, current]) => {
        if (controller.signal.aborted || activeRef.current !== activeId) return;
        // Seed once from the pinned source; existing drafts, including {}, win.
        const nextAnswers = startingAssignmentAnswers(loaded.taskInstance, current.current);
        const nextRevision = current.current?.revision ?? 0;
        answersRef.current = nextAnswers;
        revisionRef.current = nextRevision;
        savedStampRef.current = fingerprint(current.current?.answers ?? {});
        setJsonLoadMs(Math.round(performance.now() - fetchStart));
        setDetail(loaded);
        setAnswers(nextAnswers);
        setRevision(nextRevision);
        setSaveState(
          current.current?.status === "submitted" ? "submitted"
            : fingerprint(nextAnswers) !== savedStampRef.current ? "dirty" : "saved",
        );
        // Starting a task is a best-effort status update, never necessary to
        // block reading the task definition or listening to the recording.
        if (loaded.assignment.status === "assigned") {
          void startAssignment(activeId, labellerId)
            .then(({ assignment }) => {
              setQueue((rows) =>
                rows.map((row) =>
                  row.id === assignment.id ? assignment : row,
                ),
              );
            })
            .catch(() => {
              // Another tab may have started it. Server checks status on writes.
            });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setFeedback(messageOf(error));
          setSaveState("error");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingTask(false);
      });
    return () => controller.abort();
  }, [activeId, labellerId]);

  // Cache ONE next task's JSON detail only. This is never a WAV prefetch.
  // Annotations are not cached: draft revisions are mutable and must be read fresh.
  useEffect(() => {
    if (!detail || index < 0 || index + 1 >= queue.length) return;
    const next = queue[index + 1];
    if (prefetchCache.current.has(next.id)) return;
    let stopped = false;
    const controller = new AbortController();
    void getAssignmentDetail(next.id, controller.signal)
      .then((value) => {
        if (!stopped) {
          prefetchCache.current.clear();
          prefetchCache.current.set(next.id, value);
        }
      })
      .catch(() => {
        /* Optional prefetch failures must not block annotation. */
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [detail, index, queue]);

  const updateAnswers = useCallback(
    (next: Answers) => {
      if (submittingRef.current || saveState === "submitted" || votingClosed) return;
      answersRef.current = next;
      setAnswers(next);
      setIssues([]);
      setFeedback("");
      setSaveState(
        fingerprint(next) === savedStampRef.current ? "saved" : "dirty",
      );
    },
    [saveState, votingClosed],
  );

  const saveOnce = useCallback(async (): Promise<boolean> => {
    if (votingClosedRef.current) return true;
    const id = activeRef.current;
    if (!id || submittingRef.current) return false;
    if (saveInFlight.current) return saveInFlight.current;
    const copy = answersRef.current;
    const stamp = fingerprint(copy);
    if (stamp === savedStampRef.current) return true;
    setSaveState("saving");
    setFeedback("");
    const request = (async () => {
      try {
        const result = await writeAnnotation(
          id,
          labellerId,
          revisionRef.current,
          copy,
          "draft",
        );
        if (activeRef.current !== id) return false;
        revisionRef.current = result.annotation.revision;
        savedStampRef.current = stamp;
        setRevision(result.annotation.revision);
        setSaveState(
          fingerprint(answersRef.current) === stamp ? "saved" : "dirty",
        );
        return true;
      } catch (error) {
        if (activeRef.current === id) {
          setSaveState(
            error instanceof ApiError && error.status === 409
              ? "conflict"
              : "error",
          );
          setFeedback(messageOf(error));
          setIssues(validationMessages(error));
        }
        return false;
      }
    })();
    saveInFlight.current = request;
    try {
      return await request;
    } finally {
      if (saveInFlight.current === request) saveInFlight.current = null;
    }
  }, [labellerId]);

  // A navigation-triggered save must include any changes made while the first
  // request was in flight. Limit retries to avoid waiting forever if editing continues.
  const flushDraft = useCallback(async () => {
    if (votingClosedRef.current) return true;
    for (let attempt = 0; attempt < 4; attempt++) {
      const prior = saveInFlight.current;
      if (prior && !(await prior)) return false;
      if (fingerprint(answersRef.current) === savedStampRef.current)
        return true;
      if (!(await saveOnce())) return false;
    }
    return fingerprint(answersRef.current) === savedStampRef.current;
  }, [saveOnce]);

  // 3-second debounce reduces one-request-per-keystroke / timeline-drag writes.
  // A blocked 409 is NOT silently retried, which would overwrite another tab.
  useEffect(() => {
    if (
      !detail ||
      votingClosed ||
      !isDirty ||
      submitting ||
      saveState === "conflict" ||
      saveState === "error" ||
      saveState === "submitted"
    )
      return;
    const timeout = window.setTimeout(() => {
      void saveOnce();
    }, 3000);
    return () => window.clearTimeout(timeout);
  }, [answers, detail, isDirty, saveState, saveOnce, submitting, votingClosed]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (
        (!votingClosedRef.current &&
          fingerprint(answersRef.current) !== savedStampRef.current) ||
        saveInFlight.current ||
        submittingRef.current
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, []);

  async function navigate(id: string) {
    if (!id || id === activeRef.current || submittingRef.current) return;
    if (saveState === "conflict") {
      setFeedback("Resolve the revision conflict before leaving this task.");
      return;
    }
    const ok = await flushDraft();
    if (!ok) {
      setFeedback(
        "Draft was not saved. Remaining on this task to protect your work.",
      );
      return;
    }
    setDetail(null);
    setLoadingTask(true);
    setActiveId(id);
  }

  async function submit() {
    const id = activeRef.current;
    if (
      !id ||
      !detail ||
      !blocks.length ||
      submittingRef.current ||
      loadingTask ||
      saveState === "conflict"
    )
      return;
    const problems = checkAnswers(blocks, answersRef.current);
    if (problems.length) {
      setIssues(problems);
      setFeedback("Complete the required fields before submitting.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFeedback("");
    try {
      // Never race a final submission against a debounced draft write.
      if (saveInFlight.current && !(await saveInFlight.current)) {
        throw new Error("The draft save failed. Resolve it before submitting.");
      }
      const copy = answersRef.current;
      const result = await writeAnnotation(
        id,
        labellerId,
        revisionRef.current,
        copy,
        "submit",
      );
      revisionRef.current = result.annotation.revision;
      savedStampRef.current = fingerprint(copy);
      setRevision(result.annotation.revision);
      setSaveState("submitted");
      setQueue((current) => current.filter((item) => item.id !== id));
      prefetchCache.current.delete(id);
      // Queue removes completed assignments. Moving forward is safe only
      // after the server acknowledged a submitted revision.
      const remaining = queue.filter((item) => item.id !== id);
      setDetail(null);
      setLoadingTask(true);
      setActiveId(remaining[0]?.id ?? null);
    } catch (error) {
      setSaveState(
        error instanceof ApiError && error.status === 409
          ? "conflict"
          : "error",
      );
      setFeedback(messageOf(error));
      if (error instanceof ApiError && error.status === 422) {
        setIssues(validationMessages(error));
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function reloadServerDraft() {
    const id = activeRef.current;
    if (
      !id ||
      !window.confirm(
        "Discard local edits and reload the server's latest revision?",
      )
    )
      return;
    try {
      const current = await getCurrentAnnotation(id, labellerId);
      if (activeRef.current !== id) return;
      const updated = startingAssignmentAnswers(detail?.taskInstance ?? {}, current.current);
      answersRef.current = updated;
      revisionRef.current = current.current?.revision ?? 0;
      savedStampRef.current = fingerprint(current.current?.answers ?? {});
      setAnswers(updated);
      setRevision(revisionRef.current);
      setSaveState(
        current.current?.status === "submitted" ? "submitted"
          : fingerprint(updated) !== savedStampRef.current ? "dirty" : "saved",
      );
      setFeedback("");
      setIssues([]);
    } catch (error) {
      setFeedback(messageOf(error));
    }
  }

  if (!projectId || !labellerId)
    return (
      <main className="alw-shell">
        <section className="alw-empty">
          <h1>Labeller Workspace</h1>
          <p>
            Provide <code>projectId</code> and <code>labellerId</code> in the
            URL for local development.
          </p>
          <code>
            /labeller/workspace?projectId=PROJECT_UUID&amp;labellerId=dev-alice
          </code>
          <p className="alw-warning">
            DEV ONLY — the current backend does not authenticate this identity.
          </p>
        </section>
      </main>
    );

  return (
    <main className="alw-shell">
      <aside className="alw-sidebar" aria-label="Annotation queue">
        <div className="alw-identity">
          <strong>AudioLab</strong>
          <span>Labeller Workspace</span>
          <small>Member: {labellerId}</small>
        </div>
        <div className="alw-queue-head">
          <h2>My queue</h2>
          <span>{queue.length} loaded</span>
          <button
            type="button"
            className="alw-refresh"
            disabled={queueLoading || isDirty || submitting}
            onClick={() => void loadPage()}
          >
            Refresh
          </button>
        </div>
        {queueError && (
          <p role="alert" className="alw-error">
            {queueError}
          </p>
        )}
        <div className="alw-queue-list">
          {queue.map((row, i) => (
            <button
              type="button"
              key={row.id}
              className={`alw-queue-item ${row.id === activeId ? "selected" : ""}`}
              aria-current={row.id === activeId ? "step" : undefined}
              onClick={() => void navigate(row.id)}
              disabled={submitting}
            >
              <span className="alw-queue-number">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span>
                <strong>{row.definitionName || "Unnamed task"}</strong>
                <small>{row.originalPath || row.assetId}</small>
              </span>
              <em>
                {row.status === "in_progress" ? "In progress" : "Assigned"}
              </em>
            </button>
          ))}
        </div>
        {queueLoading && <p className="alw-muted">Loading queue…</p>}
        {nextCursor && (
          <button
            type="button"
            className="alw-secondary"
            disabled={queueLoading}
            onClick={() => void loadPage(nextCursor)}
          >
            Load 20 more
          </button>
        )}
        {!queueLoading && queue.length === 0 && !queueError && (
          <p className="alw-muted">No active assignments on this page.</p>
        )}
      </aside>

      <section className="alw-main">
        <header className="alw-topbar">
          <div>
            <small>PROJECT {projectId.slice(0, 8)} · DEV WORKSPACE</small>
            <h1>
              {detail?.taskInstance.definition.name ?? "Annotation workspace"}
            </h1>
          </div>
          <div className="alw-save-indicator" aria-live="polite">
            <span className={`alw-state alw-${saveState}`}>
              {saveState === "saving"
                ? "Saving…"
                : saveState === "dirty"
                  ? "Unsaved edits"
                  : saveState === "saved"
                    ? "All changes saved"
                    : saveState === "conflict"
                      ? "Revision conflict"
                      : saveState === "submitted"
                        ? "Submitted"
                        : saveState === "loading"
                          ? "Loading"
                          : "Save error"}
            </span>
            <small>Revision {revision}</small>
          </div>
        </header>

        {feedback && (
          <div className="alw-alert" role="alert">
            <strong>Attention</strong>
            <p>{feedback}</p>
            {saveState === "conflict" && (
              <button
                type="button"
                className="alw-secondary"
                onClick={() => void reloadServerDraft()}
              >
                Reload server revision (discard edits)
              </button>
            )}
          </div>
        )}
        {issues.length > 0 && (
          <div className="alw-alert" role="alert">
            <strong>Answer problems</strong>
            <ul>
              {issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          </div>
        )}

        {loadingTask && (
          <div className="alw-empty">
            <p>Loading assigned task and current answers…</p>
          </div>
        )}
        {!loadingTask && !detail && (
          <div className="alw-empty">
            <p>
              {activeId
                ? "Could not open this task."
                : "Select an assignment from your queue."}
            </p>
          </div>
        )}
        {!loadingTask && detail && (
          <>
            <div className="alw-task-summary">
              <span className="alw-tag">
                {detail.taskInstance.definition.domain}
              </span>
              <span className="alw-tag">
                Definition v{detail.taskInstance.definitionVersion}
              </span>
              <span className="alw-tag">
                {samples?.batchAudio?.length ?? 1} audio slot(s)
              </span>
              <span className="alw-tag">
                {selected?.status ?? detail.assignment.status}
              </span>
              {jsonLoadMs !== null && (
                <span className="alw-tag">Task JSON: {jsonLoadMs} ms</span>
              )}
            </div>
            {detail.taskInstance.definition.description && (
              <p className="alw-description">
                {detail.taskInstance.definition.description}
              </p>
            )}
            {(detail.taskInstance.resolvedDefinition ?? detail.taskInstance.definition).instructions && (
              <section className="alw-instructions">
                <h2>Instructions</h2>
                <p>{(detail.taskInstance.resolvedDefinition ?? detail.taskInstance.definition).instructions}</p>
              </section>
            )}
            {detail.taskInstance.sourceRecord?.question && (
              <section className="alw-instructions">
                <h2>Source question</h2>
                <p>{detail.taskInstance.sourceRecord.question}</p>
                {detail.taskInstance.sourceRecord.choices && (
                  <p>
                    Choices:{" "}
                    {detail.taskInstance.sourceRecord.choices.join(" · ")}
                  </p>
                )}
              </section>
            )}
            <div className="alw-primary-audio">
              <div>
                <strong>Primary recording</strong>
                <small>{detail.taskInstance.originalPath}</small>
              </div>
              <audio
                controls
                preload="none"
                src={detail.taskInstance.audioUrl}
                aria-label="Primary recording"
              />
            </div>
            {blocks.length === 0 && (
              <div className="alw-alert" role="alert">
                This published definition has no readable V4 blocks. Ask an
                administrator to inspect its snapshot before submitting.
              </div>
            )}
            <section
              className="alw-annotation-area"
              aria-label="Task annotation fields"
            >
              <fieldset
                className="alw-fieldset"
                disabled={saveState === "submitted" || submitting || votingClosed}
              >
                <BlockFields
                  key={activeId ?? "empty"}
                  blocks={blocks}
                  answers={answers}
                  onChange={updateAnswers}
                  samples={samples}
                  allowLocalAudio={false}
                />
              </fieldset>
            </section>
            <footer className="alw-toolbar">
              <div>
                <button
                  className="alw-secondary"
                  type="button"
                  disabled={submitting || index <= 0}
                  onClick={() => {
                    if (index > 0) void navigate(queue[index - 1].id);
                  }}
                >
                  Previous
                </button>
                <button
                  className="alw-secondary"
                  type="button"
                  disabled={
                    submitting || index < 0 || index >= queue.length - 1
                  }
                  onClick={() => {
                    if (index >= 0 && index < queue.length - 1)
                      void navigate(queue[index + 1].id);
                  }}
                >
                  Next
                </button>
              </div>
              <div>
                <button
                  className="alw-secondary"
                  type="button"
                  disabled={
                    submitting ||
                    saveState === "conflict" ||
                    saveState === "submitted" ||
                    votingClosed
                  }
                  onClick={() => void flushDraft()}
                >
                  Save draft
                </button>
                <button
                  className="alw-primary"
                  type="button"
                  disabled={
                    submitting ||
                    !blocks.length ||
                    saveState === "conflict" ||
                    saveState === "submitted" ||
                    votingClosed
                  }
                  onClick={() => void submit()}
                >
                  {submitting ? "Submitting…" : "Submit annotation"}
                </button>
              </div>
            </footer>
          </>
        )}
        <p className="alw-warning">
          Local development only. Query-string labeller IDs are not
          authenticated sessions.
        </p>
      </section>
    </main>
  );
}
