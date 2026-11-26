"use client";
import { useEffect, useRef, useState } from "react";
import { adminRequest as api } from "@/lib/frontend/admin-api";
import FinalResults from "./FinalResults";
import type { JobResults as Results } from "@/lib/contracts/job-results";
import type { JobSummary, JobPlan } from "@/lib/contracts/team-jobs";
import type { TaskInstancePreview } from "@/lib/contracts/task-instances";
import type { Block } from "@/components/task-builder/model";
import WorkbenchLayout from "@/components/workbench/WorkbenchLayout";
import BlockFields from "@/components/workbench/BlockFields";
import { toLabellerSamples } from "@/lib/frontend/labeller-samples";

type Detail = {
  summary: JobSummary;
  plan: JobPlan;
  workerProgress: Array<{
    userId: string;
    displayName: string;
    total: number;
    submitted: number;
  }>;
  assignments: Array<{
    id: string;
    userId: string;
    status: string;
    itemKey: string;
    itemKeys?: string[];
    answers: Record<string, unknown> | null;
    revision: number | null;
  }>;
};
/** Admin team progress and task inspection reuse the existing persisted
 * assignment/revision renderer. A worker filter never changes the job totals.
 */
export default function TeamJobProgress({
  projectId,
  initialJobId = "",
}: {
  projectId: string;
  initialJobId?: string;
}) {
  // Ignore a delayed inspection response after switching jobs or opening another task.
  const taskRequest = useRef(0);
  const [view, setView] = useState("Progress Overview");
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobs, setJobs] = useState<JobSummary[]>([]),
    [jobId, setJobId] = useState(initialJobId),
    [detail, setDetail] = useState<Detail | null>(null),
    [results, setResults] = useState<Results | null>(null);
  const [worker, setWorker] = useState(""),
    [status, setStatus] = useState("all"),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [task, setTask] = useState<{
    taskInstance: TaskInstancePreview;
    current: Detail["assignments"][number];
  } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setJobsLoading(true);
    api<{ jobs: JobSummary[] }>(
      `team-jobs?projectId=${projectId}`,
      undefined,
      abort.signal,
    )
      .then((data) => {
        if (!abort.signal.aborted) {
          setJobs(data.jobs);
          setJobId((previous) =>
            data.jobs.some((job) => job.id === previous)
              ? previous
              : (data.jobs[0]?.id ?? ""),
          );
        }
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(String(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setJobsLoading(false);
      });
    return () => abort.abort();
  }, [projectId, revision]);
  useEffect(() => {
    const abort = new AbortController();
    taskRequest.current += 1;
    setDetail(null);
    setResults(null);
    setTask(null);
    setLoading(false);
    setWorker("");
    setError("");
    if (jobId) {
      setLoading(true);
      Promise.allSettled([
        api<Detail>(
          `team-jobs?action=detail&projectId=${projectId}&jobId=${jobId}`,
          undefined,
          abort.signal,
        ),
        api<Results>(
          `team-jobs?action=results&projectId=${projectId}&jobId=${jobId}`,
          undefined,
          abort.signal,
        ),
      ])
        .then(([d, r]) => {
          if (!abort.signal.aborted) {
            if (d.status === "fulfilled") setDetail(d.value);
            if (r.status === "fulfilled") setResults(r.value);
            const failures = [d, r].filter(
              (value) => value.status === "rejected",
            );
            if (failures.length)
              setError(
                failures
                  .map((value) =>
                    value.status === "rejected" ? String(value.reason) : "",
                  )
                  .join("; "),
              );
          }
        })
        .catch((reason) => {
          if (!abort.signal.aborted) setError(String(reason));
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }
    return () => abort.abort();
  }, [projectId, jobId, revision]);
  async function open(id: string) {
    const generation = ++taskRequest.current;
    setTask(null);
    setLoading(true);
    setError("");
    try {
      const response = await api<NonNullable<typeof task>>(
        `team-jobs?action=task&projectId=${projectId}&jobId=${jobId}&assignmentId=${id}`,
      );
      if (generation === taskRequest.current) setTask(response);
    } catch (reason) {
      if (generation === taskRequest.current) setError(String(reason));
    } finally {
      if (generation === taskRequest.current) setLoading(false);
    }
  }
  const shown =
    detail?.assignments.filter(
      (a) =>
        (!worker || a.userId === worker) &&
        (status === "all" || status === a.status),
    ) ?? [];
  return (
    <div className="admin-workspace">
      <section className="admin-panel">
        <div className="admin-toolbar">
          <h2>Labeller progress</h2>
          <button disabled={loading} onClick={() => setRevision((r) => r + 1)}>
            Refresh progress
          </button>
        </div>
        <label>
          Team job
          <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">Choose job</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.name} · {job.definitionName} v{job.definitionVersion}
              </option>
            ))}
          </select>
        </label>
        <nav className="progress-views" aria-label="Labeller progress views">
          {["Progress Overview", "Labeller Analysis", "Final Results"].map(
            (name) => (
              <button
                key={name}
                aria-pressed={view === name}
                onClick={() => setView(name)}
              >
                {name}
              </button>
            ),
          )}
        </nav>
        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}
        {(loading || jobsLoading) && (
          <p role="status">Loading saved progress…</p>
        )}
        {!jobsLoading && !jobs.length && !error && <p>No team jobs yet.</p>}
        {detail && (
          <>
            {view === "Progress Overview" && (
              <>
                <div className="admin-stats">
                  <section>
                    <span>Source items fully labelled</span>
                    <strong>
                      {detail.summary.fullyLabelledItems}/{detail.summary.items}
                    </strong>
                  </section>
                  <section>
                    <span>Individual submissions</span>
                    <strong>
                      {detail.summary.submitted}/{detail.plan.pairs.length}
                    </strong>
                  </section>
                  <section>
                    <span>Workers</span>
                    <strong>{detail.summary.workers}</strong>
                  </section>
                </div>
                <p>
                  {detail.summary.mode === "voting"
                    ? "Every worker has the same selected items; an item is complete only after all independent submissions."
                    : "Items are partitioned without overlap; each item needs one submission."}
                </p>
                {detail.plan.batches && (
                  <p>
                    {detail.plan.batches.length} Task Instances ×{" "}
                    {detail.plan.recordingsPerTask} recordings per task;
                    assignment counts below are worker tasks, not audio counts.
                  </p>
                )}
                <p>
                  Unique audio recordings:{" "}
                  {new Set(detail.plan.items.map((i) => i.assetId)).size} ·
                  source items: {detail.summary.items} · assignments:{" "}
                  {detail.plan.pairs.length} · submitted annotations:{" "}
                  {detail.summary.submitted}
                </p>
              </>
            )}
            {view === "Labeller Analysis" && (
              <>
                <label>
                  Filter worker
                  <select
                    value={worker}
                    onChange={(e) => setWorker(e.target.value)}
                  >
                    <option value="">All job workers</option>
                    {detail.plan.workers.map((w) => (
                      <option key={w.userId} value={w.userId}>
                        {w.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="admin-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Worker</th>
                        <th>Submitted / assigned</th>
                        <th>Pending</th>
                        <th>Completion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.workerProgress
                        .filter((w) => !worker || worker === w.userId)
                        .map((w) => (
                          <tr key={w.userId}>
                            <td>{w.displayName}</td>
                            <td>
                              {w.submitted}/{w.total}
                            </td>
                            <td>{w.total - w.submitted}</td>
                            <td>
                              {w.total
                                ? `${Math.round((100 * w.submitted) / w.total)}%`
                                : "No assigned items"}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>
      {detail && view === "Labeller Analysis" && (
        <section className="admin-panel">
          <h2>Task board</h2>
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All statuses</option>
              {["assigned", "in_progress", "submitted", "reviewed"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <div className="admin-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Item / question</th>
                  <th>Labeller</th>
                  <th>Status</th>
                  <th>Revision</th>
                  <th>Task</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.itemKeys && a.itemKeys.length > 1 && (
                        <strong>{a.itemKeys.length} recordings · </strong>
                      )}
                      {detail.plan.items.find((i) => i.key === a.itemKey)
                        ?.question ??
                        detail.plan.items.find((i) => i.key === a.itemKey)
                          ?.itemId ??
                        a.itemKey}
                    </td>
                    <td>
                      {detail.plan.workers.find((w) => w.userId === a.userId)
                        ?.displayName ?? a.userId}
                    </td>
                    <td>{a.status}</td>
                    <td>{a.revision ?? "—"}</td>
                    <td>
                      <button onClick={() => void open(a.id)}>
                        Open task instance
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!shown.length && <p>No tasks match this filter.</p>}
        </section>
      )}
      {task && (
        <section className="admin-panel admin-task-inspection">
          <div className="admin-toolbar">
            <h2>Task instance (read-only)</h2>
            <button
              onClick={() => {
                taskRequest.current += 1;
                setTask(null);
                setLoading(false);
              }}
            >
              Close
            </button>
          </div>
          <p>
            {task.taskInstance.definitionName} · v
            {task.taskInstance.definitionVersion} · {task.current.status}
          </p>
          <p>
            {
              (
                task.taskInstance.resolvedDefinition ??
                task.taskInstance.definition
              ).instructions
            }
          </p>
          {/* Use the same layout/CSS scope and pinned form as the actual Workspace. */}
          <WorkbenchLayout
            name={task.taskInstance.definitionName}
            instructions={
              (
                task.taskInstance.resolvedDefinition ??
                task.taskInstance.definition
              ).instructions
            }
            queue={<p>Read-only assignment inspection</p>}
            grounding={
              <audio
                key={task.taskInstance.id}
                controls
                preload="metadata"
                src={task.taskInstance.audioUrl}
              />
            }
          >
            <fieldset className="allocation-controls">
              <BlockFields
                readOnly
                blocks={
                  (
                    task.taskInstance.resolvedDefinition ??
                    task.taskInstance.definition
                  ).blocks as Block[]
                }
                answers={
                  task.current.answers ?? task.taskInstance.initialAnswers ?? {}
                }
                onChange={() => {}}
                samples={toLabellerSamples(
                  task.taskInstance,
                  (
                    task.taskInstance.resolvedDefinition ??
                    task.taskInstance.definition
                  ).blocks as Block[],
                )}
                allowLocalAudio={false}
              />
            </fieldset>
          </WorkbenchLayout>
        </section>
      )}
      {detail && view === "Final Results" && (
        <section className="admin-panel">
          <h2>Final Results</h2>
          {results ? (
            <FinalResults key={jobId} results={results} />
          ) : (
            <p>No saved results available.</p>
          )}
        </section>
      )}
    </div>
  );
}
