"use client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Users, RefreshCw, Plus, Headphones } from "lucide-react";
import { adminRequest as api } from "@/lib/frontend/admin-api";
import type { AssignmentSummary, ProjectMemberRecord } from "@/lib/contracts/assignment-api";
import type { TaskInstancePreview, TaskInstanceSummary } from "@/lib/contracts/task-instances";
import "./admin.css";

type Choice = { id: string; name: string };
type Definition = Choice & { publishedVersion: number };
type Asset = { id: string; originalPath: string };
type Source = { sourceRecordId: string; question: string | null };
const statusLabel = (value: string) => value.replaceAll("_", " ");

export default function AdminWorkspace({ projectId, progress = false, onMembersChanged }: {
  projectId: string; progress?: boolean; onMembersChanged: () => void;
}) {
  const [members, setMembers] = useState<ProjectMemberRecord[]>([]);
  const [instances, setInstances] = useState<TaskInstanceSummary[]>([]);
  const [assignments, setAssignments] = useState<AssignmentSummary[]>([]);
  const [datasets, setDatasets] = useState<Choice[]>([]);
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [dataset, setDataset] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [asset, setAsset] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [source, setSource] = useState("");
  const [protocol, setProtocol] = useState("");
  const [instance, setInstance] = useState("");
  const [labeller, setLabeller] = useState("");
  const [filter, setFilter] = useState("all");
  const [preview, setPreview] = useState<TaskInstancePreview | null>(null);
  const [detailStatus, setDetailStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const detailSequence = useRef(0);
  const query = `projectId=${encodeURIComponent(projectId)}`;
  async function load(signal?: AbortSignal) {
    const [m, i, a, d, p] = await Promise.all([
      api<{ members: ProjectMemberRecord[] }>(`project-members?${query}`, undefined, signal),
      api<{ instances: TaskInstanceSummary[] }>(`task-instances?${query}`, undefined, signal),
      api<{ assignments: AssignmentSummary[] }>(`assignments?${query}`, undefined, signal),
      api<{ datasets: Choice[] }>(`datasets?${query}`, undefined, signal),
      api<{ definitions: Definition[] }>(`task-definitions?${query}`, undefined, signal),
    ]);
    if (!mounted.current || signal?.aborted) return;
    setMembers(m.members); setInstances(i.instances); setAssignments(a.assignments);
    setDatasets(d.datasets); setDefinitions(p.definitions.filter(x => x.publishedVersion > 0));
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (!projectId) { setLoading(false); return () => { mounted.current = false; }; }
    void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(String(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; controller.abort(); };
    // The parent keys this workspace by project and view, clearing all selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    setAssets([]); setAsset("");
    if (dataset) void api<{ assets: Asset[] }>(`assets?datasetId=${encodeURIComponent(dataset)}`, undefined, controller.signal)
      .then(x => { if (!controller.signal.aborted) setAssets(x.assets); })
      .catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [dataset]);
  useEffect(() => {
    const controller = new AbortController();
    setSources([]); setSource("");
    if (asset) void api<{ sourceRecords: Source[] }>(`source-records?assetId=${encodeURIComponent(asset)}`, undefined, controller.signal)
      .then(x => { if (!controller.signal.aborted) setSources(x.sourceRecords); })
      .catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [asset]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    await run(async () => {
      await api("project-members", { projectId, userId: String(values.get("userId")).trim(), displayName: String(values.get("displayName")).trim(), role: "labeller" });
      if (!mounted.current) return;
      form.reset(); onMembersChanged(); setNotice("Demo Labeller added."); await load();
    });
  }
  async function showDetail(id: string) {
    const sequence = ++detailSequence.current;
    setPreview(null); setDetailStatus("");
    await run(async () => {
      const result = await api<{ assignment: AssignmentSummary; taskInstance: TaskInstancePreview }>(`assignments/${id}`);
      if (mounted.current && sequence === detailSequence.current) { setPreview(result.taskInstance); setDetailStatus(result.assignment.status); }
    });
  }
  if (!projectId) return <section className="al-panel">Select a project to manage its team.</section>;
  const people = members.filter(m => m.role === "labeller");
  return <div className="admin-workspace" aria-busy={busy || loading}>
    <div className="admin-toolbar"><p>Manage independent annotation work in this project.</p><button disabled={busy || loading} onClick={() => void run(() => load())}><RefreshCw size={16}/> Refresh</button></div>
    <div className="admin-note">Local development workspace · Demo members are testing records, not authenticated accounts.</div>
    {error && <div className="admin-error" role="alert">{error} <button disabled={busy} onClick={() => void run(() => load())}>Retry loading</button></div>}
    {notice && <p className="admin-success" role="status">{notice}</p>}
    {loading ? <p role="status">Loading project workspace…</p> : <>
    <div className="admin-stats">{["assigned", "in_progress", "submitted"].map(status => <section className="admin-panel" key={status}><span>{statusLabel(status)}</span><strong>{assignments.filter(a => a.status === status).length}</strong><small>Loaded assignments</small></section>)}</div>
    <p className="admin-hint">Pilot counts cover the returned rows (assignment API limit: 200). Review and reporting analytics are future backend work.</p>
    {!progress && <>
    <div className="admin-grid">
      <section className="admin-panel"><h2><Users size={20}/> Project members</h2><p className="admin-hint">Each Labeller can receive one independent assignment per task instance.</p>
        <div className="admin-members">{members.map(m => <div className="admin-member" key={m.userId}><div><b>{m.displayName}</b><small>{m.userId}</small></div><span className="admin-badge">{m.role}</span></div>)}{!members.length && <p>No members yet. Add a demo Labeller below.</p>}</div>
        <form onSubmit={addMember}><h3>Add demo Labeller</h3><label>Display name<input name="displayName" required maxLength={120}/></label><label>Local user ID<input name="userId" required maxLength={128} placeholder="demo-labeller-1"/></label><button className="admin-primary" disabled={busy}><Plus size={16}/> Add demo Labeller</button></form>
      </section>
      <section className="admin-panel"><h2><Headphones size={20}/> Create annotation job</h2><p className="admin-hint">Choose a saved recording and a fixed published protocol.</p>
        <label>Dataset<select value={dataset} onChange={e => setDataset(e.target.value)} disabled={busy}><option value="">Choose a dataset</option>{datasets.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>Recording<select value={asset} disabled={!dataset || busy} onChange={e => setAsset(e.target.value)}><option value="">Choose a recording</option>{assets.map(a => <option key={a.id} value={a.id}>{a.originalPath}</option>)}</select></label>
        <label>Published protocol<select value={protocol} disabled={busy} onChange={e => setProtocol(e.target.value)}><option value="">Choose a published version</option>{definitions.flatMap(d => Array.from({ length: d.publishedVersion }, (_, i) => <option key={`${d.id}:${i + 1}`} value={`${d.id}:${i + 1}`}>{d.name} · v{i + 1}</option>))}</select></label>
        {!definitions.length && <p className="admin-hint">Publish a definition in Task Builder to create jobs.</p>}
        <label>Source question (optional)<select value={source} disabled={!asset || busy} onChange={e => setSource(e.target.value)}><option value="">No source question</option>{sources.map(s => <option key={s.sourceRecordId} value={s.sourceRecordId}>{s.question ?? s.sourceRecordId}</option>)}</select></label>
        <button className="admin-primary" disabled={busy || !asset || !protocol} onClick={() => void run(async () => {
          const [definitionId, version] = protocol.split(":");
          const result = await api<{ taskInstance: TaskInstancePreview }>("task-instances", { projectId, definitionId, definitionVersion: Number(version), assetId: asset, ...(source ? { sourceRecordId: source } : {}) });
          if (!mounted.current) return;
          setPreview(result.taskInstance); setDetailStatus(""); setInstance(result.taskInstance.id); setNotice("Annotation job created. Preview it below, then assign a Labeller."); await load();
        })}><Plus size={16}/> Create job</button>
        <p className="admin-hint">This form creates single-recording jobs. Protocols requiring multiple recordings return a validation error.</p>
      </section>
    </div>
    <section className="admin-panel"><h2>Assign a job</h2><div className="admin-grid"><label>Task instance<select value={instance} disabled={busy} onChange={e => setInstance(e.target.value)}><option value="">Choose a job</option>{instances.map(i => <option key={i.id} value={i.id}>{i.definitionName} v{i.definitionVersion} · {i.originalPath} · {i.id.slice(0, 8)}</option>)}</select></label><label>Labeller<select value={labeller} disabled={busy} onChange={e => setLabeller(e.target.value)}><option value="">Choose a Labeller</option>{people.map(p => <option key={p.userId} value={p.userId}>{p.displayName}</option>)}</select></label></div>
      <button className="admin-primary" disabled={busy || !instance || !labeller} onClick={() => void run(async () => { await api("assignments", { projectId, taskInstanceId: instance, labellerId: labeller }); if (!mounted.current) return; setNotice("Assignment created. You can assign this same job to another Labeller."); await load(); })}>Create assignment</button>
    </section></>}
    <section className="admin-panel"><div className="admin-toolbar"><h2>Assignment board</h2><label>Status<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All statuses</option>{["assigned", "in_progress", "submitted", "reviewed"].map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label></div>
      <div className="admin-table-scroll"><table><thead><tr><th>Job / recording</th><th>Labeller</th><th>Status</th><th>Details</th></tr></thead><tbody>{assignments.filter(a => filter === "all" || a.status === filter).map(a => <tr key={a.id}><td><b>{a.definitionName} · v{a.definitionVersion}</b><small>{a.originalPath}</small></td><td>{a.labellerName}</td><td><span className={`admin-badge ${a.status}`}>{statusLabel(a.status)}</span></td><td><button disabled={busy} onClick={() => void showDetail(a.id)}>Open</button></td></tr>)}</tbody></table></div>
      {!assignments.some(a => filter === "all" || a.status === filter) && <p>No assignments in this view.</p>}
    </section>
    {preview && <section className="admin-panel"><div className="admin-toolbar"><h2>Task preview</h2><button onClick={() => { ++detailSequence.current; setPreview(null); }}>Close preview</button></div><h3>{preview.definition.name} · v{preview.definitionVersion}</h3>{detailStatus && <span className={`admin-badge ${detailStatus}`}>{statusLabel(detailStatus)}</span>}<p className="admin-instructions">{preview.definition.instructions || "No additional instructions."}</p><a href={preview.audioUrl} target="_blank" rel="noreferrer">Open recording</a><audio controls preload="none" src={preview.audioUrl}/>{preview.sourceRecord && <p>{preview.sourceRecord.question}</p>}<ul>{preview.definition.blocks.map(b => <li key={b.id}>{b.label} <small>{b.type}{b.required ? " · Required" : ""}</small></li>)}</ul></section>}
    </>}
  </div>;
}
