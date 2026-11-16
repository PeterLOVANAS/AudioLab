"use client";
/**
 * ProjectConfiguration — Feature 1
 *
 * Ported from prototype `components/research/admin.tsx → Settings` component.
 * Rendered when page === "settings" in admin mode.
 *
 * Uses the existing main-branch API endpoints:
 *   POST /api/v1/projects          — create a project
 *   GET  /api/v1/projects          — list projects
 *   GET  /api/v1/task-definitions  — list task definitions for a project
 *   POST /api/v1/task-definitions  — create a task definition
 */
import { useEffect, useState } from "react";
import {
  SlidersHorizontal,
  Plus,
  Check,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// ─── helpers ────────────────────────────────────────────────────────────────

function human(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="al-cfg-field">
      <span>{label}</span>
      <input
        className="al-cfg-input"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <label className="al-cfg-field">
      <span>{label}</span>
      <textarea
        className="al-cfg-input"
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="al-cfg-field">
      <span>{label}</span>
      <select
        className="al-cfg-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ErrorBox({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div className="al-cfg-error" role="alert">
      {error}
    </div>
  );
}

function JsonDetails({ label, data }: { label: string; data: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="al-cfg-details" open={open}>
      <summary onClick={() => setOpen((v) => !v)}>
        {label} {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </summary>
      <pre className="al-cfg-json">{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

// ─── types ───────────────────────────────────────────────────────────────────

type Project = { id: string; name: string; slug: string };

type TaskDefinition = {
  id: string;
  name: string;
  projectId: string;
  version?: number;
};

type KindKey = "project" | "task-definition";

// ─── blank forms ─────────────────────────────────────────────────────────────

const blankProject = { name: "", slug: "" };
const blankTaskDef = { name: "", projectId: "" };

// ─── main component ──────────────────────────────────────────────────────────

type Props = {
  projectId: string;
  projects: Project[];
  onSaved: () => void;
};

export default function ProjectConfiguration({
  projectId,
  projects,
  onSaved,
}: Props) {
  const [kind, setKind] = useState<KindKey>("project");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // ── Project form ──
  const [projectForm, setProjectForm] = useState(blankProject);
  const changeProject = (p: Partial<typeof blankProject>) =>
    setProjectForm((f) => ({ ...f, ...p }));

  // ── Task-definition form ──
  const [taskDefForm, setTaskDefForm] = useState(blankTaskDef);
  const changeTaskDef = (p: Partial<typeof blankTaskDef>) =>
    setTaskDefForm((f) => ({ ...f, ...p }));

  // ── Existing task definitions for the selected project ──
  const [taskDefs, setTaskDefs] = useState<TaskDefinition[]>([]);
  const [taskDefsError, setTaskDefsError] = useState("");

  useEffect(() => {
    if (!projectId) return;
    setTaskDefs([]);
    setTaskDefsError("");
    const params = new URLSearchParams({ projectId });
    fetch(`/api/v1/task-definitions?${params}`, { cache: "no-store" })
      .then(async (r) => {
        const d = (await r.json()) as {
          definitions?: TaskDefinition[];
          error?: string;
        };
        if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
        setTaskDefs(d.definitions ?? []);
      })
      .catch((e) => setTaskDefsError(String(e)));
  }, [projectId, notice]); // re-fetch after a successful save

  // ensure task-def form always has the active project pre-selected
  useEffect(() => {
    setTaskDefForm((f) => ({ ...f, projectId }));
  }, [projectId]);

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (kind === "project") {
        const r = await fetch("/api/v1/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(projectForm),
        });
        const d = (await r.json()) as { error?: string; project?: Project };
        if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
        setNotice(`Project "${d.project?.name}" created.`);
        setProjectForm(blankProject);
        onSaved();
      } else {
        // task-definition
        if (!taskDefForm.projectId) {
          throw new Error("Select a project before creating a task definition.");
        }
        const r = await fetch("/api/v1/task-definitions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: taskDefForm.projectId,
            name: taskDefForm.name,
          }),
        });
        const d = (await r.json()) as {
          error?: string;
          definition?: TaskDefinition;
        };
        if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
        setNotice(`Task definition "${d.definition?.name}" created.`);
        setTaskDefForm({ name: "", projectId: taskDefForm.projectId });
        onSaved();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const kinds: KindKey[] = ["project", "task-definition"];

  return (
    <div className="al-cfg-grid">
      {/* ── Left panel: create form ── */}
      <section className="al-panel al-cfg-panel">
        <div className="al-cfg-heading">
          <h2>Versioned research setup</h2>
          <SlidersHorizontal size={20} />
        </div>

        {/* Kind tabs — reuse existing sidebar tab style */}
        <div className="al-cfg-tabs">
          {kinds.map((k) => (
            <button
              key={k}
              className={kind === k ? "active" : ""}
              onClick={() => {
                setKind(k);
                setError("");
                setNotice("");
              }}
            >
              {human(k)}
            </button>
          ))}
        </div>

        <p className="al-cfg-hint">
          Create a new project or task-definition version. Previously created
          tasks retain the configuration they were created with.
        </p>

        <ErrorBox error={error} />
        {notice && <div className="al-cfg-success">{notice}</div>}

        {/* ── Project form ── */}
        {kind === "project" && (
          <>
            <Field
              label="Project name"
              value={projectForm.name}
              onChange={(name) => changeProject({ name })}
              placeholder="Audio negation study"
            />
            <Field
              label="URL slug (lowercase, hyphens only)"
              value={projectForm.slug}
              onChange={(slug) => changeProject({ slug })}
              placeholder="audio-negation-study"
            />
          </>
        )}

        {/* ── Task-definition form ── */}
        {kind === "task-definition" && (
          <>
            <SelectField
              label="Project"
              value={taskDefForm.projectId}
              onChange={(projectId) => changeTaskDef({ projectId })}
              options={[
                { value: "", label: "Choose a project…" },
                ...projects.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
            <Field
              label="Definition name"
              value={taskDefForm.name}
              onChange={(name) => changeTaskDef({ name })}
              placeholder="Sound grounding v1"
            />
          </>
        )}

        <button
          className="al-cfg-btn-primary"
          disabled={busy}
          onClick={() => void save()}
        >
          <Check size={15} />
          {busy ? "Saving…" : "Save new version"}
        </button>
      </section>

      {/* ── Right panel: existing records ── */}
      <section className="al-panel al-cfg-panel">
        <h3>
          Available{" "}
          {kind === "project"
            ? "projects"
            : "task definitions"}
        </h3>

        {kind === "project" &&
          (projects.length === 0 ? (
            <p className="al-cfg-hint">No projects yet.</p>
          ) : (
            projects.map((p) => (
              <div className="al-cfg-card" key={p.id}>
                <b>{p.name}</b>
                <p className="al-cfg-card-sub">
                  {p.id} · /{p.slug}
                </p>
                <JsonDetails label="Configuration" data={p} />
              </div>
            ))
          ))}

        {kind === "task-definition" && (
          <>
            {taskDefsError && <ErrorBox error={taskDefsError} />}
            {taskDefs.length === 0 ? (
              <p className="al-cfg-hint">
                No task definitions for this project yet.
              </p>
            ) : (
              taskDefs.map((d) => (
                <div className="al-cfg-card" key={d.id}>
                  <b>{d.name}</b>
                  <p className="al-cfg-card-sub">
                    {d.id}
                    {d.version !== undefined ? ` · v${d.version}` : ""}
                  </p>
                  <JsonDetails label="Configuration" data={d} />
                </div>
              ))
            )}
          </>
        )}
      </section>
    </div>
  );
}
