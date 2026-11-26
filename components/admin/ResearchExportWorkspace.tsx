"use client";
import { useEffect, useRef, useState } from "react";
import type {
  ResearchExport,
  ExportAudioItem,
  ExportAudioBlock,
  ChoiceDistribution,
  ResearchBlock,
} from "@/lib/contracts/research-export";
import type { JobSummary } from "@/lib/contracts/team-jobs";
import { adminRequest as api } from "@/lib/frontend/admin-api";
import { toLabellerSamples } from "@/lib/frontend/labeller-samples";
import BlockFields from "@/components/workbench/BlockFields";
import type { Block } from "@/components/task-builder/model";
import { ReadableAnnotation, ReadableValue } from "./ReadableAnnotation";
import { readableBlockAnswer } from "@/lib/contracts/readable-answers";
import "./research-export.css";

/** Counts show all independent finals; no winning answer is silently selected. */
export function ExportChoiceChart({
  label,
  value,
}: {
  label: string;
  value: ChoiceDistribution;
}) {
  return (
    <section className="export-chart" aria-label={label}>
      <h4>{label}</h4>
      <p>
        {value.submitted} submitted answers. Multiple-choice selections can
        total more than the number of answers.
      </p>
      {value.counts.map((option) => (
        <div className="export-vote-row" key={option.id}>
          <span>{option.label}</span>
          <div className="export-vote-track">
            <span
              style={{
                width: `${value.submitted ? (option.count / value.submitted) * 100 : 0}%`,
              }}
            />
          </div>
          <strong>{option.count}</strong>
        </div>
      ))}
      {!value.submitted && <p>No submitted answers yet.</p>}
    </section>
  );
}
/** Render only an actually submitted ranking, in its exact stored ID order. */
export function ExportRankingPreview({
  block,
  value,
  task,
}: {
  block: ResearchBlock;
  value: unknown;
  task: ResearchExport["tasks"][number];
}) {
  const ordered = Array.isArray(value) ? value : [];
  return (
    <section className="export-answer">
      <h3>{block.label}</h3>
      <p className="export-id">Task-scoped ranking · block {block.id}</p>
      {!ordered.length ? (
        <p>No submitted ranking.</p>
      ) : (
        <ol>
          {ordered.map((id, index) => {
            const slot =
              typeof id === "string" ? Number(id.replace(/^slot-/, "")) : NaN;
            const asset =
              block.rankingMode !== "labels" && Number.isInteger(slot)
                ? task.task.audioAssets?.[slot]
                : undefined;
            const label =
              block.rankingMode === "labels" && Array.isArray(block.rankLabels)
                ? (
                    block.rankLabels as Array<{ id: string; label: string }>
                  ).find((option) => option.id === id)?.label
                : Array.isArray(block.stimulusSlots)
                  ? block.stimulusSlots[slot]
                  : undefined;
            return (
              <li key={`${id}:${index}`}>
                <strong>{String(label ?? id)}</strong>

                {asset && <audio controls preload="none" src={asset.url} />}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
/** Each comparison retains its ordered recording context and readable choice.
 * Voting uses the existing per-group distribution charts instead.
 */
export function ExportComparisonPreview({
  block,
  value,
  task,
}: {
  block: ResearchBlock;
  value: unknown;
  task: ResearchExport["tasks"][number];
}) {
  const size =
    typeof block.comparisonSize === "number" ? block.comparisonSize : 2;
  const count = typeof block.numBatch === "number" ? block.numBatch : 2;
  const answers = Array.isArray(value) ? value : [];
  return (
    <section className="export-answer">
      <h3>{block.label}</h3>
      {Array.from({ length: count / size }, (_, index) => (
        <section key={index}>
          <h4>Comparison {index + 1}</h4>
          <div className="export-comparison-audio">
            {task.task.audioAssets
              ?.slice(index * size, (index + 1) * size)
              .map((asset) => (
                <label key={asset.id}>
                  {asset.originalPath ?? `Audio ${asset.position + 1}`}
                  <audio controls preload="none" src={asset.url} />
                </label>
              ))}
          </div>
          <p>
            Submitted answer:{" "}
            <ReadableValue
              value={readableBlockAnswer(
                { ...block, type: "single_choice", numBatch: 1 },
                answers[index],
              )}
            />
          </p>
        </section>
      ))}
    </section>
  );
}
function AudioAnswer({
  entry,
  audio,
  worker,
}: {
  entry: ExportAudioBlock;
  audio: ExportAudioItem;
  worker: string;
}) {
  if (entry.distribution)
    return (
      <ExportChoiceChart label={entry.block.label} value={entry.distribution} />
    );
  const annotation = worker
    ? entry.annotations.find((value) => value.workerId === worker)
    : entry.annotations[0];
  if (!annotation)
    return (
      <section className="export-answer">
        <h4>{entry.block.label}</h4>
        <p>No submitted answer for this selection.</p>
      </section>
    );
  return (
    <section className="export-answer">
      <p>
        {annotation
          ? `${annotation.workerId} · revision ${annotation.revision}`
          : "No submitted answer for this selection."}
      </p>
      <ReadableAnnotation
        block={entry.block}
        value={annotation.value}
        audioLabels={[audio.originalPath]}
      />
      <div className="tb-workbench export-form">
        <BlockFields
          blocks={[{ ...entry.block, showWhen: undefined }] as Block[]}
          answers={annotation ? { [entry.block.id]: annotation.value } : {}}
          onChange={() => {}}
          readOnly
          allowLocalAudio={false}
          samples={{
            primaryUrl: audio.audioUrl,
            primaryMeta: {
              durationSeconds: audio.durationSeconds ?? undefined,
            },
            batchAudio: [
              {
                id: audio.audioId,
                url: audio.audioUrl,
                label: audio.originalPath,
              },
            ],
          }}
        />
      </div>
    </section>
  );
}
/** Job selection owns the export snapshot. Abort old loads/downloads on project
 * changes; lazy-open one audio/task preview to avoid decoding every R2 recording.
 * The server selects finals and safe source fields; UI filters are not privacy.
 */
export default function ResearchExportWorkspace({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName?: string;
}) {
  const [jobs, setJobs] = useState<JobSummary[]>([]),
    [jobId, setJobId] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [data, setData] = useState<ResearchExport | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0),
    [view, setView] = useState<"audio" | "tasks">("audio"),
    [search, setSearch] = useState("");
  const [page, setPage] = useState(0),
    [openAudio, setOpenAudio] = useState(""),
    [openTask, setOpenTask] = useState("");
  const [worker, setWorker] = useState(""),
    [downloading, setDownloading] = useState(""),
    [notice, setNotice] = useState("");
  const downloadController = useRef<AbortController | null>(null);
  useEffect(() => () => downloadController.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    setCatalogLoading(true);
    api<{ jobs: JobSummary[] }>(
      `team-jobs?projectId=${projectId}${includeArchived ? "&includeArchived=1" : ""}`,
      undefined,
      abort.signal,
    )
      .then((result) => {
        if (!abort.signal.aborted) {
          setJobs(result.jobs);
          setJobId((current) =>
            result.jobs.some((job) => job.id === current)
              ? current
              : (result.jobs[0]?.id ?? ""),
          );
        }
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(String(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setCatalogLoading(false);
      });
    return () => abort.abort();
  }, [projectId, refresh, includeArchived]);
  useEffect(() => {
    const abort = new AbortController();
    setData(null);
    setPage(0);
    setOpenAudio("");
    setOpenTask("");
    setWorker("");
    setNotice("");
    downloadController.current?.abort();
    setDownloading("");
    if (!jobId) {
      setLoading(false);
      return () => abort.abort();
    }
    setLoading(true);
    setError("");
    api<ResearchExport>(
      `research-export?projectId=${projectId}&jobId=${jobId}`,
      undefined,
      abort.signal,
    )
      .then((result) => {
        if (!abort.signal.aborted) setData(result);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(String(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [projectId, jobId, refresh]);
  async function download(format: string, audioId?: string) {
    downloadController.current?.abort();
    const abort = new AbortController();
    downloadController.current = abort;
    setDownloading(format);
    setError("");
    setNotice("");
    try {
      const query = new URLSearchParams({
        projectId,
        jobId,
        format,
        ...(audioId ? { audioId } : {}),
      });
      const response = await fetch(`/api/v1/research-export?${query}`, {
        cache: "no-store",
        signal: abort.signal,
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? `Export HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        response.headers
          .get("content-disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "audiolab-export";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Download prepared. Check your browser’s downloads.");
    } catch (reason) {
      if (!abort.signal.aborted) setError(String(reason));
    } finally {
      if (!abort.signal.aborted) setDownloading("");
    }
  }
  const workers = [
    ...new Set(
      data?.tasks.flatMap((task) =>
        task.annotations.map((value) => value.workerId),
      ) ?? [],
    ),
  ];
  const filteredAudio =
    data?.audioItems.filter((audio) =>
      JSON.stringify([
        audio.audioId,
        audio.originalPath,
        audio.sourceItems.map((item) => [
          item.sampleId,
          item.itemId,
          item.fields.filter(
            (field) =>
              field.id.includes("question") || field.id.includes("prompt"),
          ),
        ]),
      ])
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  const filteredTasks =
    data?.tasks.filter((task) =>
      `${task.id} ${task.task.definitionName} ${task.sourceKeys.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  const total = view === "audio" ? filteredAudio.length : filteredTasks.length;
  const selectedTask = data?.tasks.find((task) => task.id === openTask);
  const taskAnnotation = worker
    ? selectedTask?.annotations.find((value) => value.workerId === worker)
    : selectedTask?.annotations[0];
  const effective =
    selectedTask?.task.resolvedDefinition ?? selectedTask?.task.definition;
  const taskBlocks =
    effective?.blocks.filter(
      (block) =>
        block.type !== "ranking" &&
        block.type !== "audio_comparison" &&
        !(
          data?.job.mode === "voting" &&
          [
            "single_choice",
            "multiple_choice",
            "boolean",
            "audio_comparison",
          ].includes(block.type)
        ),
    ) ?? [];
  if (!projectId)
    return (
      <section className="al-panel">Choose an authorized project.</section>
    );
  return (
    <div className="research-export">
      <section className="al-panel" aria-busy={loading || catalogLoading}>
        <p className="export-hint">
          Current project: {projectName ?? projectId}
        </p>
        <div className="export-toolbar">
          <label>
            Research job
            <select
              className="export-select"
              value={jobId}
              onChange={(event) => setJobId(event.target.value)}
            >
              <option value="">Choose a job</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.deletedAt ? "[Deleted] " : ""}
                  {job.name} · {job.definitionName} v{job.definitionVersion} ·{" "}
                  {job.submitted}/{job.assignments} submitted
                </option>
              ))}
            </select>
          </label>
          <label className="export-history-toggle">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            Include deleted jobs (history)
          </label>
          <button
            className="export-button"
            onClick={() => setRefresh((value) => value + 1)}
            disabled={loading || !!downloading}
          >
            Refresh
          </button>
        </div>
        <p>
          Submitted revisions only. Drafts and hidden reference answers are
          excluded. Exports include worker IDs and immutable revision
          provenance.
        </p>
        {!catalogLoading && !jobs.length && !error && (
          <p>
            No active jobs in this project. Create a job in Team & Assignments
            first.
          </p>
        )}
        {catalogLoading && <p role="status">Loading research jobs…</p>}
        {loading && (
          <p role="status">Loading pinned tasks and submitted annotations…</p>
        )}
        {error && (
          <p className="export-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {data && (
          <>
            {data.job.deletedAt && (
              <p className="export-note">
                Deleted job: historical submitted revisions are available for
                export. Assignments remain read-only.
              </p>
            )}
            <p>
              <strong>
                {data.totals.exportedSubmissions}/
                {data.totals.expectedSubmissions}
              </strong>{" "}
              submitted assignments · {data.totals.sourceItems} source items ·{" "}
              {data.totals.taskInstances} Task Instances ·{" "}
              {data.totals.annotatedAudio} audio files linked to final
              submissions.
            </p>
            {data.totals.exportedSubmissions <
              data.totals.expectedSubmissions && (
              <p className="export-note">
                This job is incomplete. Downloads contain the available finals;
                missing submissions are not filled with drafts or source
                answers.
              </p>
            )}
            <div className="export-toolbar">
              <button
                className="export-button"
                disabled={!!downloading}
                onClick={() => void download("json")}
              >
                Download job JSON
              </button>
              <button
                className="export-button"
                disabled={!!downloading || !data.totals.exportedSubmissions}
                onClick={() => void download("json-zip")}
              >
                Per-audio JSON ZIP
              </button>
              <button
                className="export-button export-primary"
                disabled={!!downloading || !data.totals.exportedSubmissions}
                onClick={() => void download("audio-zip")}
              >
                JSON + annotated audio ZIP
              </button>
            </div>
            {downloading && <p role="status">Preparing download…</p>}
            <p className="export-hint">
              ZIP: annotations/AUDIO_ID.json matches audio/AUDIO_ID.wav. Ranking
              and Audio Comparison stay at whole-task scope. Voting bars show
              distributions, not an accepted answer; JSON preserves every
              independent final. The annotator selector affects individual block
              previews; Voting bars always include all submitted annotators.
            </p>
          </>
        )}
      </section>
      {data && (
        <>
          <section className="al-panel export-toolbar">
            <button
              className="export-button"
              aria-pressed={view === "audio"}
              onClick={() => {
                setView("audio");
                setPage(0);
              }}
            >
              Audio & source items
            </button>
            <button
              className="export-button"
              aria-pressed={view === "tasks"}
              onClick={() => {
                setView("tasks");
                setPage(0);
              }}
            >
              Task Instances
            </button>
            <input
              className="export-input"
              aria-label="Search export board"
              placeholder="Search IDs, filenames or questions"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
            <label>
              Inspect submission
              <select
                className="export-select"
                value={worker}
                onChange={(event) => setWorker(event.target.value)}
              >
                <option value="">First available submitted annotator</option>
                {workers.map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
          </section>
          {view === "audio" ? (
            filteredAudio.slice(page * 10, page * 10 + 10).map((audio) => (
              <article className="al-panel" key={audio.audioId}>
                <div className="export-toolbar">
                  <h2>{audio.originalPath}</h2>
                  <button
                    className="export-button"
                    onClick={() =>
                      setOpenAudio((current) =>
                        current === audio.audioId ? "" : audio.audioId,
                      )
                    }
                  >
                    {openAudio === audio.audioId
                      ? "Close preview"
                      : "Preview audio & annotations"}
                  </button>
                  <button
                    className="export-button"
                    disabled={!!downloading}
                    onClick={() => void download("audio-json", audio.audioId)}
                  >
                    Audio JSON
                  </button>
                </div>
                <p className="export-id">
                  audio_id: {audio.audioId} ·{" "}
                  {audio.durationSeconds
                    ? `${audio.durationSeconds.toFixed(2)} s`
                    : "Duration unavailable"}
                </p>
                {openAudio === audio.audioId && (
                  <>
                    <audio controls preload="metadata" src={audio.audioUrl} />
                    {audio.sourceItems.map((item, index) => (
                      <section
                        className="export-source"
                        key={`${item.sourceKey}:${index}`}
                      >
                        <h3>
                          {item.itemId ?? item.sourceRecordId ?? "Source item"}
                        </h3>
                        <p className="export-id">
                          Sample {item.sampleId ?? "—"} · source{" "}
                          {item.sourceRecordId ?? "—"} · version{" "}
                          {item.sourceVersion ?? "legacy"}
                        </p>
                        <details>
                          <summary>
                            {item.fieldsOrigin === "current-source"
                              ? "Source fields read at export time (not historically pinned)"
                              : "Pinned source fields"}
                          </summary>
                          {item.fields.map((field) => (
                            <div key={field.id}>
                              <strong>{field.id}</strong>
                              <pre>{JSON.stringify(field.value, null, 2)}</pre>
                            </div>
                          ))}
                        </details>
                        {item.blocks.map((entry) => (
                          <AudioAnswer
                            key={`${entry.taskInstanceId}:${entry.block.id}`}
                            entry={entry}
                            audio={audio}
                            worker={worker}
                          />
                        ))}
                        {!item.blocks.length && (
                          <p>
                            Annotations are task-scoped. Open the Task Instance
                            below for Ranking or Audio Comparison.
                          </p>
                        )}
                      </section>
                    ))}
                    <div className="export-toolbar">
                      {audio.taskReferences.map((id) => (
                        <button
                          className="export-button"
                          key={id}
                          onClick={() => {
                            setOpenTask(id);
                            setView("tasks");
                            setSearch("");
                            setPage(0);
                          }}
                        >
                          Open Task Instance {id.slice(0, 8)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </article>
            ))
          ) : (
            <>
              {filteredTasks.slice(page * 10, page * 10 + 10).map((task) => (
                <article className="al-panel" key={task.id}>
                  <h2>
                    {task.task.definitionName} · v{task.task.definitionVersion}
                  </h2>
                  <p className="export-id">
                    Task Instance {task.id} ·{" "}
                    {task.task.audioAssets?.length ?? 1} recordings ·{" "}
                    {task.annotations.length}/{task.expectedSubmissions}{" "}
                    submitted
                  </p>
                  <button
                    className="export-button"
                    onClick={() =>
                      setOpenTask((current) =>
                        current === task.id ? "" : task.id,
                      )
                    }
                  >
                    Open task preview
                  </button>
                </article>
              ))}
              {selectedTask && effective && (
                <section className="al-panel">
                  <div className="export-toolbar">
                    <h2>Whole-task annotation preview</h2>
                    <button
                      className="export-button"
                      onClick={() => setOpenTask("")}
                    >
                      Close preview
                    </button>
                  </div>
                  <p>{effective.instructions}</p>
                  <p>
                    {taskAnnotation
                      ? `${taskAnnotation.workerId} · revision ${taskAnnotation.revision} · ${taskAnnotation.revisionId}`
                      : "No submitted answer for this selection."}
                  </p>
                  {data.job.mode === "voting" &&
                    selectedTask.distributions.map((value) => {
                      const block = effective.blocks.find(
                        (block) => block.id === value.blockId,
                      );
                      const panel =
                        value.audioPosition !== null &&
                        Array.isArray(block?.batchBlocks)
                          ? (block.batchBlocks[
                              value.audioPosition
                            ] as ResearchBlock)
                          : block;
                      const per =
                        typeof block?.comparisonSize === "number"
                          ? block.comparisonSize
                          : 2;
                      return (
                        <section
                          key={`${value.blockId}:${value.audioPosition}:${value.comparisonIndex ?? ""}`}
                        >
                          {value.comparisonIndex !== undefined && (
                            <div className="export-comparison-audio">
                              {selectedTask.task.audioAssets
                                ?.slice(
                                  value.comparisonIndex * per,
                                  (value.comparisonIndex + 1) * per,
                                )
                                .map((asset) => (
                                  <label key={asset.id}>
                                    Audio {asset.position + 1}
                                    <audio
                                      controls
                                      preload="none"
                                      src={asset.url}
                                    />
                                  </label>
                                ))}
                            </div>
                          )}
                          <ExportChoiceChart
                            label={`${panel?.label ?? value.blockId}${value.audioPosition !== null ? ` · Audio ${value.audioPosition + 1}` : value.comparisonIndex !== undefined ? ` · Comparison ${value.comparisonIndex + 1}` : ""}`}
                            value={value.value}
                          />
                        </section>
                      );
                    })}
                  {data.job.mode !== "voting" &&
                    effective.blocks
                      .filter((block) => block.type === "audio_comparison")
                      .map((block) => (
                        <ExportComparisonPreview
                          key={block.id}
                          block={block}
                          task={selectedTask}
                          value={taskAnnotation?.answers[block.id]}
                        />
                      ))}
                  {taskAnnotation &&
                    taskBlocks
                      .filter((block) =>
                        Object.hasOwn(taskAnnotation.answers, block.id),
                      )
                      .map((block) => (
                        <ReadableAnnotation
                          key={block.id}
                          block={block}
                          value={taskAnnotation.answers[block.id]}
                          audioLabels={selectedTask.task.audioAssets?.map(
                            (asset) =>
                              asset.originalPath ??
                              `Audio ${asset.position + 1}`,
                          )}
                        />
                      ))}
                  {effective.blocks
                    .filter((block) => block.type === "ranking")
                    .map((block) => (
                      <ExportRankingPreview
                        key={block.id}
                        block={block}
                        task={selectedTask}
                        value={taskAnnotation?.answers[block.id]}
                      />
                    ))}
                  {taskAnnotation && (
                    <div className="tb-workbench export-form">
                      <BlockFields
                        key={`${selectedTask.id}:${taskAnnotation?.revisionId ?? "empty"}`}
                        blocks={taskBlocks as Block[]}
                        answers={taskAnnotation?.answers ?? {}}
                        onChange={() => {}}
                        samples={toLabellerSamples(
                          selectedTask.task,
                          taskBlocks as Block[],
                        )}
                        readOnly
                        allowLocalAudio={false}
                      />
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          {!total && (
            <section className="al-panel">
              No entries match this search.
            </section>
          )}
          <div className="export-toolbar">
            <button
              className="export-button"
              disabled={!page}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </button>
            <span>
              {total
                ? `${page * 10 + 1}–${Math.min((page + 1) * 10, total)} of ${total}`
                : "0 entries"}
            </span>
            <button
              className="export-button"
              disabled={(page + 1) * 10 >= total}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
