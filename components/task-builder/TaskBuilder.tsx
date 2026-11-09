"use client";
import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  BookOpen,
  ChevronRight,
  Eye,
  FilePlus2,
  Headphones,
  Layers,
  Pencil,
  Save,
  Send,
} from "lucide-react";
import type { Project } from "@/lib/contracts/projects";
import BlockEditor, { Field, Palette } from "./BlockEditor";
import BlockFields, { checkAnswers, type Answers } from "../workbench/BlockFields";
import WorkbenchLayout from "../workbench/WorkbenchLayout";
import AudioPreviewPicker from "./AudioPreviewPicker";
import WorkspaceSettings from "./WorkspaceSettings";
import type { Samples } from "../workbench/BlockFields";
import {
  blankDraft,
  publishLimit,
  checkDraft,
  exampleDraft,
  newBlock,
  readBlock,
  type Draft,
  type EditableKind,
} from "./model";
import "./task-builder.css";

type Saved = { id: string; draftRevision: number; publishedVersion: number; draft: Draft };
type Summary = { id: string; name: string; draftRevision: number; publishedVersion: number };
type Issue = { path?: (string | number)[]; message: string };
class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
async function api<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/v1/" + path, {
    method,
    signal,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = (data ?? {}) as { issues?: Issue[]; error?: string };
    const details = (failure.issues ?? [])
      .map((issue: Issue) => [issue.path?.join("."), issue.message].filter(Boolean).join(" · "))
      .join("\n");
    throw new RequestError(
      response.status,
      details || failure.error || "Request failed (" + response.status + ").",
    );
  }
  return data as T;
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Unable to contact the server.";
}
const seed = blankDraft();

export default function TaskBuilder({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const [mode, setMode] = useState<"compose" | "preview">("compose");
  const [draft, setDraft] = useState<Draft>(seed);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectReady, setProjectReady] = useState(false);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [listError, setListError] = useState("");
  const [showIssues, setShowIssues] = useState(false);
  const [answers, setAnswers] = useState<Answers>({});
  const [checked, setChecked] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  // Preview assets are independent from the definition JSON. A reusable
  // protocol never contains paths/URLs for arbitrary test recordings.
  const [samples, setSamples] = useState<Samples>({});
  const requestInProgress = useRef(false);
  const addedId = useRef("");
  const canvas = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved?.draft ?? seed);
  const limits = [...new Set(draft.blocks.map(publishLimit).filter(Boolean))];
  const unsupported = limits.length > 0;
  const problems = showIssues ? checkDraft(draft) : [];
  const trialProblems = checked ? checkAnswers(draft.blocks, answers) : [];
  // One preview can exercise every NUM_BATCH mode without embedding WAV IDs
  // into the reusable frozen Task Definition.
  const previewBatchCount=Math.max(1,...draft.blocks.map(b=>
    b.type==="ranking" && b.rankingMode!=="labels" ?
      Math.max(b.numBatch??1,b.stimulusSlots?.length??1) : b.numBatch??1));
  const previewSlots = draft.blocks.flatMap(block => [
    ...(block.stimulusSlots ?? []), ...(block.stimulusSlot ? [block.stimulusSlot] : []),
  ]);

  useEffect(() => {
    onDirty(dirty);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, onDirty]);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogError("");
    api<{ projects: Project[] }>("projects", "GET", undefined, controller.signal)
      .then(({ projects: choices }) => {
        if (controller.signal.aborted) return;
        setProjects(choices);
        setProjectId(
          (existing) =>
            existing ||
            (choices.find((project) => project.slug === "negation-study") ?? choices[0])?.id ||
            "",
        );
        setProjectReady(true);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCatalogError(errorText(error));
      });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setListError("");
    if (projectId)
      api<{ definitions: Summary[] }>(
        "task-definitions?projectId=" + encodeURIComponent(projectId),
        "GET",
        undefined,
        controller.signal,
      )
        .then((data) => {
          if (!controller.signal.aborted) setSummaries(data.definitions);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setListError(errorText(error));
        });
    return () => controller.abort();
  }, [projectId, refresh]);
  useEffect(() => {
    if (!addedId.current) return;
    const panel = canvas.current?.querySelector<HTMLElement>('[data-block="' + addedId.current + '"]');
    addedId.current = "";
    if (panel) {
      panel.querySelector("details")?.setAttribute("open", "");
      panel.querySelector<HTMLInputElement>(".tb-settings input")?.focus();
    }
  }, [draft.blocks]);

  function resetTrial() {
    setAnswers({});
    setChecked(false);
    setPreviewKey((value) => value + 1);
  }
  function edit(next: Draft) {
    setDraft(next);
    setMessage("");
    setError("");
    resetTrial();
  }
  function add(kind: EditableKind) {
    const block = newBlock(kind);
    addedId.current = block.id;
    edit({ ...draft, blocks: [...draft.blocks, block] });
  }
  function canReplace() {
    return !dirty || window.confirm("Discard unsaved changes to this definition?");
  }
  function start(next: Draft) {
    setSaved(null);
    setShowIssues(false);
    setConflict(false);
    setMode("compose");
    edit(next);
  }
  function load(record: Saved) {
    const next = { ...record.draft, blocks: record.draft.blocks.map(readBlock) };
    setSaved({ ...record, draft: next });
    setDraft(next);
    setConflict(false);
    setShowIssues(false);
    resetTrial();
  }
  async function run(action: () => Promise<void>) {
    if (requestInProgress.current) return;
    requestInProgress.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (error) {
      setError(errorText(error));
      if (saved && error instanceof RequestError && error.status === 409) setConflict(true);
    } finally {
      requestInProgress.current = false;
      setBusy(false);
    }
  }
  function open(id: string) {
    if (!id || !canReplace()) return;
    void run(async () => {
      const result = await api<{ taskDefinition: Saved }>("task-definitions/" + id);
      load(result.taskDefinition);
      setMessage("Opened revision " + result.taskDefinition.draftRevision + ".");
    });
  }
  function save() {
    setShowIssues(true);
    if (checkDraft(draft).length) {
      setMode("compose");
      return;
    }
    if (!projectId || conflict) return;
    void run(async () => {
      const result = saved
        ? await api<{ taskDefinition: Saved }>("task-definitions/" + saved.id, "PUT", {
            expectedRevision: saved.draftRevision,
            draft,
          })
        : await api<{ taskDefinition: Saved }>("task-definitions", "POST", { projectId, draft });
      load(result.taskDefinition);
      setRefresh((value) => value + 1);
      setMessage("Draft saved · revision " + result.taskDefinition.draftRevision + ".");
    });
  }
  function publish() {
    if (!saved || dirty || unsupported || conflict || checkDraft(draft).length) return;
    void run(async () => {
      const { published } = await api<{ published: { version: number } }>(
        "task-definitions/" + saved.id + "/publish",
        "POST",
        {
          expectedRevision: saved.draftRevision,
          expectedPublishedVersion: saved.publishedVersion,
        },
      );
      setSaved({ ...saved, publishedVersion: published.version });
      setRefresh((value) => value + 1);
      setMessage("Published version " + published.version + ". Definition ID · " + saved.id);
    });
  }
  function createProject() {
    void run(async () => {
      const { project } = await api<{ project: Project }>("projects", "POST", {
        name: "Audio negation study",
        slug: "negation-study",
      });
      setProjects([project]);
      setProjectId(project.id);
      setRefresh((value) => value + 1);
      setMessage("Project created. You can now save your draft.");
    });
  }
  return (
    <fieldset className="tb" disabled={busy} aria-busy={busy} aria-label="Task builder">
      <header className="tb-header">
        <div>
          <p className="tb-eyebrow">RESEARCH OPERATIONS</p>
          <h1>Task Builder</h1>
          <p>Compose the questions your labellers will answer.</p>
        </div>
        <div className="tb-actions">
          <button
            type="button"
            onClick={() => {
              if (canReplace()) start(blankDraft());
            }}
          >
            <FilePlus2 size={16} />
            New
          </button>
          <button type="button" onClick={save} disabled={!projectId || conflict || (!!saved && !dirty)}>
            <Save size={16} />
            Save draft
          </button>
          <button
            type="button"
            className="tb-primary"
            onClick={publish}
            disabled={!saved || dirty || unsupported || conflict}
            title={
              unsupported
                ? "This definition contains blocks with draft and preview support only."
                : "Publish the last saved draft"
            }
          >
            <Send size={15} />
            Publish
          </button>
        </div>
      </header>
      <div className="tb-filebar">
        <Field label="Save to project">
          <select
            value={projectId}
            onChange={(event) => {
              if (!canReplace()) return;
              setSummaries([]);
              setProjectId(event.target.value);
              start(blankDraft());
            }}
          >
            <option value="" disabled>
              {projectReady ? "No project selected" : "Loading projects…"}
            </option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Open definition">
          <select value={saved?.id ?? ""} onChange={(event) => open(event.target.value)}>
            <option value="" disabled>
              {summaries.length ? "Choose a saved draft…" : "No saved drafts"}
            </option>
            {saved && (
              <option value={saved.id}>
                {saved.draft.name} · rev {saved.draftRevision}
              </option>
            )}
            {summaries
              .filter((row) => row.id !== saved?.id)
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · rev {row.draftRevision}
                </option>
              ))}
          </select>
        </Field>
        <div className="tb-status">
          <span className={dirty ? "tb-dot dirty" : "tb-dot"} />
          {busy
            ? "Working…"
            : dirty
              ? "Unsaved changes"
              : saved
                ? "Saved · rev " + saved.draftRevision
                : "New definition"}
          {saved && saved.publishedVersion > 0 && <small>Published v{saved.publishedVersion}</small>}
        </div>
      </div>
      {projectReady && !projects.length && !catalogError && (
        <div className="tb-notice">
          Create the local project to save this definition.{" "}
          <button type="button" onClick={createProject}>
            Create demo project
          </button>
        </div>
      )}
      {(catalogError || listError) && (
        <div className="tb-notice" role="alert">
          {catalogError || listError} · Check your local database setup.{" "}
          <button type="button" onClick={() => setRefresh((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}
      {error && (
        <div className="tb-notice bad" role="alert">
          {error}{" "}
          {conflict && saved && (
            <button type="button" onClick={() => open(saved.id)}>
              Reload saved copy
            </button>
          )}
        </div>
      )}
      {message && (
        <p className="tb-notice ok" role="status">
          {message}
        </p>
      )}
      <div className="tb-modes">
        <div role="group" aria-label="Builder view">
          <button type="button" aria-pressed={mode === "compose"} onClick={() => setMode("compose")}>
            <Pencil size={15} />
            Compose
          </button>
          <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
            <Eye size={16} />
            Labeller Preview
          </button>
        </div>
        <small>
          {draft.blocks.length} {draft.blocks.length === 1 ? "block" : "blocks"}
        </small>
      </div>
      {unsupported && (
        <p className="tb-notice">
          Draft and preview available. The labeller answer API still needs support for{" "}
          {limits.join(", ")} before this definition can be published here.
        </p>
      )}
      {problems.length > 0 && (
        <div className="tb-notice bad" role="alert">
          <strong>Before saving</strong>
          <ul>
            {problems.map((problem, index) => (
              <li key={index}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {mode === "compose" ? (
        <div className="tb-compose">
          <Palette add={add} />
          <div className="tb-stack" ref={canvas}>
            <section className="tb-panel">
              <p className="tb-eyebrow">01 / SETUP</p>
              <h2>Task details</h2>
              <div className="tb-settings">
                <div className="tb-grid tb-wide">
                  <Field label="Task name">
                    <input
                      maxLength={160}
                      placeholder="e.g. Bird-call check"
                      value={draft.name}
                      onChange={(event) => edit({ ...draft, name: event.target.value })}
                    />
                  </Field>
                  <Field label="Domain">
                    <select
                      value={draft.domain}
                      onChange={(event) =>
                        edit({ ...draft, domain: event.target.value as Draft["domain"] })
                      }
                    >
                      <option value="sound">Sound</option>
                      <option value="speech">Speech</option>
                      <option value="general">General</option>
                    </select>
                  </Field>
                </div>
                <Field label="Labeller instructions">
                  <textarea
                    rows={2}
                    maxLength={20000}
                    placeholder="Tell the labeller what to listen for."
                    value={draft.instructions}
                    onChange={(event) => edit({ ...draft, instructions: event.target.value })}
                  />
                </Field>
                <details className="tb-detail">
                  <summary>Description and review settings</summary>
                  <div className="tb-settings">
                    <Field label="Description">
                      <textarea
                        maxLength={4000}
                        value={draft.description}
                        onChange={(event) => edit({ ...draft, description: event.target.value })}
                      />
                    </Field>
                    <Field label="Independent votes">
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={draft.policy.requiredIndependentVotes || ""}
                        onChange={(event) =>
                          edit({
                            ...draft,
                            policy: {
                              ...draft.policy,
                              requiredIndependentVotes: Number(event.target.value),
                            },
                          })
                        }
                      />
                    </Field>
                    {(["blindToOthers", "requiresReview"] as const).map((key, index) => (
                      <label key={key} className="tb-check">
                        <input
                          type="checkbox"
                          checked={draft.policy[key]}
                          onChange={(event) =>
                            edit({ ...draft, policy: { ...draft.policy, [key]: event.target.checked } })
                          }
                        />
                        {index ? "Require review" : "Hide other labellers’ answers"}
                      </label>
                    ))}
                  </div>
                </details>
              </div>
            </section>
            <section className="tb-panel">
              <p className="tb-eyebrow">02 / AUDIO WORKSPACE</p>
              <h2>Labeller audio tools</h2>
              <WorkspaceSettings value={draft.workspace}
                onChange={workspace=>edit({...draft,workspace})}/>
            </section>
            <section className="tb-panel">
              <p className="tb-eyebrow">03 / COMPOSITION</p>
              <h2>Question sequence</h2>
              {draft.blocks.length ? (
                <BlockEditor blocks={draft.blocks} onChange={(blocks) => edit({ ...draft, blocks })} />
              ) : (
                <div className="tb-empty">
                  <Layers size={28} />
                  <h3>Add your first block</h3>
                  <p>Pick a question from the Block library, or try a three-question bird-call study.</p>
                  <button
                    type="button"
                    onClick={() => {
                      if (canReplace()) start(exampleDraft());
                    }}
                  >
                    <BookOpen size={15} />
                    Load bird-call example
                  </button>
                </div>
              )}
            </section>
          </div>
        </div>
      ) : (
        <div className="tb-preview-workspace">
        <AudioPreviewPicker projectId={projectId} slots={previewSlots}
          batchCount={previewBatchCount} onChange={setSamples}/>
        <WorkbenchLayout
          name={draft.name}
          instructions={draft.instructions}
          queue={
            <>
              <p className="tb-eyebrow">WORKLIST</p>
              <h2>Task queue</h2>
              <div className="tb-queue-row">
                <Headphones size={16} />
                <b>{draft.name || "Current task"}</b>
                <ChevronRight size={14} />
              </div>
              <small>Sample queue row for this preview.</small>
            </>
          }
          grounding={draft.blocks.some(b=>b.type==="timeline_annotation") ? null : (
            <section className="tb-panel tb-preview-player">
              <p className="tb-eyebrow">02 / AUDIO STIMULUS</p>
              <h3>Primary recording</h3>
              {samples.primaryUrl ? <audio controls src={samples.primaryUrl} preload="metadata" aria-label="Preview recording"/>
                : <p className="tb-muted">Select a dataset asset above to play the real WAV file.</p>}
              <p className="tb-inset">Add one Grounding block in Composition for the full original Sound/Speech workbench, including spectrogram and timelines.</p>
            </section>
          )}
        >
          <div className="tb-preview-caption">
            <span>Preview answers stay on this screen.</span>
            <button type="button" onClick={resetTrial}>
              Reset answers
            </button>
          </div>
          {draft.blocks.length ? (
            <BlockFields
              key={previewKey}
              blocks={draft.blocks}
              answers={answers}
              onChange={setAnswers}
              allowLocalAudio
              samples={samples}
            />
          ) : (
            <div className="tb-empty">
              <p>Add a block in Compose to try it here.</p>
            </div>
          )}
          {draft.blocks.length > 0 && (
            <button className="tb-trial" type="button" onClick={() => setChecked(true)}>
              Check preview answers
            </button>
          )}
          {checked && (
            <div className={"tb-notice " + (trialProblems.length ? "bad" : "ok")} role="status">
              {trialProblems.length ? (
                <ul>
                  {trialProblems.map((problem, index) => (
                    <li key={index}>{problem}</li>
                  ))}
                </ul>
              ) : (
                "Preview answers complete."
              )}
            </div>
          )}
        </WorkbenchLayout>
        </div>
      )}
    </fieldset>
  );
}
