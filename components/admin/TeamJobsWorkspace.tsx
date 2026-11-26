"use client";
import { useEffect, useRef, useState } from "react";
import { adminRequest as api } from "@/lib/frontend/admin-api";
import type {
  JobInput,
  JobPlan,
  JobSummary,
  WorkerProfile,
  Team,
} from "@/lib/contracts/team-jobs";
import type { AllocationItem } from "@/lib/contracts/assignment-allocation";
import { jobPreviewProblems } from "@/lib/frontend/job-preview-readiness";
import { readTeamJobDraft, saveTeamJobDraft } from "@/lib/frontend/team-job-draft";
import TeamJobProgress from "./TeamJobProgress";

type Catalog = {
  workers: WorkerProfile[];
  teams: Team[];
  datasets: Array<{ id: string; name: string; itemCount?:number }>;
  definitions: Array<{ id: string; name: string; publishedVersion: number; versions?:Array<{version:number;recordingsPerTask:number}> }>;
};
/** Job-level authoring owns filters, the selected team snapshot and the frozen
 * preview. Worker assignments remain implementation records, not board rows.
 */
export default function TeamJobsWorkspace({
  projectId,
  draftOwnerId = "",
  initialDatasetId = "",
}: {
  projectId: string;
  draftOwnerId?: string;
  initialDatasetId?: string;
}) {
  const [catalog, setCatalog] = useState<Catalog>({
      workers: [],
      teams: [],
      datasets: [],
      definitions: [],
    }),
    [jobs, setJobs] = useState<JobSummary[]>([]),
    [revision, setRevision] = useState(0);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [catalogLoading, setCatalogLoading] = useState(true);
  const [itemsLoading,setItemsLoading]=useState(false);
  const loading=catalogLoading||itemsLoading;
  const [previewError,setPreviewError]=useState("");
  const previewPanel=useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"jobs" | "profiles">("jobs"),
    [openJob, setOpenJob] = useState("");
  const [name, setName] = useState(""),
    [teamId, setTeamId] = useState(""),
    [teamName, setTeamName] = useState(""),
    [workers, setWorkers] = useState<string[]>([]);
  const [country, setCountry] = useState(""),
    [profession, setProfession] = useState(""),
    [language, setLanguage] = useState(""),
    [experience, setExperience] = useState(0),
    [search, setSearch] = useState("");
  const [datasetId, setDatasetId] = useState(""),
    [protocol, setProtocol] = useState(""),
    [mode, setMode] = useState<"individual" | "voting">("individual"),
    [seed, setSeed] = useState("shuffle-1"),
    [sampleCount, setSampleCount] = useState(10);
  const [useEntireDataset,setUseEntireDataset]=useState(false);
  const [items, setItems] = useState<AllocationItem[]>([]),
    [keys, setKeys] = useState<string[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [plan, setPlan] = useState<JobPlan | null>(null);
  const [profile, setProfile] = useState<WorkerProfile | null>(null),
    [metadata, setMetadata] = useState("{}");
  const [languageText, setLanguageText] = useState("");
  const [draftReady,setDraftReady]=useState(false),[draftStatus,setDraftStatus]=useState("Restoring configuration draft…");
  const restoredSelection=useRef<{dataset:string;keys:string[]}|null>(null);
  // Restore once per mounted account/project. Never restore a launch hash: the
  // current server must validate the workers, source versions and form again.
  useEffect(()=>{
    if(!draftOwnerId)return;
    try {
      const draft=readTeamJobDraft(localStorage,draftOwnerId,projectId);
      if(draft){setUseEntireDataset(draft.useEntireDataset??false);setName(draft.name);setTeamId(draft.teamId);setTeamName(draft.teamName);setWorkers(draft.workers);setDatasetId(draft.datasetId);setProtocol(draft.protocol);setMode(draft.mode);setSeed(draft.seed);setSampleCount(draft.sampleCount);setKeys(draft.keys);restoredSelection.current={dataset:draft.datasetId,keys:draft.keys};}
      setDraftStatus(draft?"Configuration draft restored from this browser. Assignments are not created yet.":"Configuration auto-save enabled in this browser.");
    }catch{setDraftStatus("Could not restore the browser draft. Check storage permissions.");}
    setDraftReady(true);
  },[draftOwnerId,projectId]);
  useEffect(()=>{if(initialDatasetId)setDatasetId(initialDatasetId);},[initialDatasetId]);
  useEffect(()=>{
    if(!draftReady||!draftOwnerId)return;
    setDraftStatus("Saving configuration draft…");
    try{saveTeamJobDraft(localStorage,draftOwnerId,projectId,{name,teamId,teamName,workers,datasetId,protocol,mode,seed,sampleCount,keys,useEntireDataset});setDraftStatus("Configuration draft saved in this browser. Preview and confirm to create assignments.");}
    catch{setDraftStatus("Auto-save failed: browser storage is unavailable or the selection exceeds limits.");}
  },[draftReady,draftOwnerId,projectId,name,teamId,teamName,workers,datasetId,protocol,mode,seed,sampleCount,keys,useEntireDataset]);

  useEffect(() => {
    const abort = new AbortController();
    setCatalogLoading(true);
    setError("");
    Promise.all([
      api<Catalog>(
        `team-jobs?action=catalog&projectId=${projectId}`,
        undefined,
        abort.signal,
      ),
      api<{ jobs: JobSummary[] }>(
        `team-jobs?projectId=${projectId}`,
        undefined,
        abort.signal,
      ),
    ])
      .then(([c, j]) => {
        if (!abort.signal.aborted) {
          setCatalog(c);
          setJobs(j.jobs);
        }
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(String(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setCatalogLoading(false);
      });
    return () => abort.abort();
  }, [projectId, revision]);
  useEffect(() => {
    const abort = new AbortController();
    setItems([]);
    if(datasetId && restoredSelection.current?.dataset!==datasetId)setKeys([]);
    setCursor(null);
    setItemsLoading(false);
    if (datasetId) {
      setItemsLoading(true);
      api<{ items: AllocationItem[]; nextCursor: string | null }>(
        `team-jobs?action=items&projectId=${projectId}&datasetId=${datasetId}`,
        undefined,
        abort.signal,
      )
        .then((value) => {
          if (!abort.signal.aborted) {
            setItems(value.items);
            const restored=restoredSelection.current;
            if(restored?.dataset===datasetId){setKeys(restored.keys);restoredSelection.current=null;}
            else {setKeys(value.items.slice(0,50).map(i=>i.key));setSampleCount(Math.min(10,value.items.length));}
            setCursor(value.nextCursor);
          }
        })
        .catch((reason) => {
          if (!abort.signal.aborted) setError(String(reason));
        })
        .finally(() => {
          if (!abort.signal.aborted) setItemsLoading(false);
        });
    }
    return () => abort.abort();
  }, [projectId, datasetId]);
  useEffect(
    () => setPlan(null),
    [name, teamId, workers, datasetId, protocol, mode, seed, sampleCount, keys,useEntireDataset],
  );
  const team = catalog.teams.find((t) => t.id === teamId);
  const eligible = catalog.workers.filter(
    (worker) =>
      worker.active &&
      worker.accountReady &&
      (!team || team.memberIds.includes(worker.userId)),
  );
  const filtered = eligible.filter(
    (w) =>
      (!country || w.country === country) &&
      (!profession || w.profession === profession) &&
      (!language || w.languages.includes(language)) &&
      w.experienceYears >= experience &&
      JSON.stringify([w.displayName, w.userId, w.metadata])
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  function changeTeam(id: string) {
    setTeamId(id);
    const found = catalog.teams.find((t) => t.id === id);
    setWorkers(found?.memberIds ?? []);
    setTeamName(found?.name ?? "");
  }
  const [selectedDefinition,selectedVersion]=protocol.split(":");
  const recordingsPerTask=catalog.definitions.find(definition=>definition.id===selectedDefinition)?.versions?.find(version=>version.version===Number(selectedVersion))?.recordingsPerTask??1;
  const datasetItemCount=catalog.datasets.find(dataset=>dataset.id===datasetId)?.itemCount??0;
  const effectiveSampleCount=useEntireDataset?datasetItemCount:sampleCount;
  const previewProblems=jobPreviewProblems({name,protocol,datasetId,workers,keys,sampleCount:effectiveSampleCount,seed,mode,recordingsPerTask,useEntireDataset});
  useEffect(()=>{if(plan)previewPanel.current?.scrollIntoView({behavior:"smooth",block:"start"});},[plan]);
  async function preview() {
    setPreviewError("");
    if(previewProblems.length){setPreviewError("Complete the requirements listed above Preview.");return;}
    await run(async () => {
      try {
      const [definitionId, v] = protocol.split(":");
      const input: JobInput = {
        jobId: crypto.randomUUID(),
        projectId,
        name,
        teamId: teamId || undefined,
        datasetId,
        definitionId,
        definitionVersion: Number(v),
        mode,
        seed,
        itemKeys: useEntireDataset?[]:keys,
        ...(useEntireDataset?{useEntireDataset:true}:{}),
        workerIds: workers,
        sampleCount:effectiveSampleCount,
      };
      const result = await api<{ plan: JobPlan }>(
        "team-jobs?action=preview",
        input,
      );
      setPlan(result.plan);
      } catch(reason){setPreviewError(String(reason));throw reason;}
    });
  }
  if (openJob)
    return (
      <div className="admin-workspace">
        <button onClick={() => setOpenJob("")}>← Team/job board</button>
        <TeamJobProgress projectId={projectId} initialJobId={openJob} />
      </div>
    );
  return (
    <div className="admin-workspace team-jobs">
      <div className="admin-note">
        Team jobs freeze their selected people, item identities, shuffle seed
        and Task Definition version. “Voting” means independent annotations of
        the same items.
      </div>
      <div className="admin-toolbar">
        <div>
          <button onClick={() => setTab("jobs")}>Team jobs</button>{" "}
          <button onClick={() => setTab("profiles")}>
            Teams & worker profiles
          </button>
        </div>
        <button disabled={busy} onClick={() => setRevision((r) => r + 1)}>
          Refresh
        </button>
      </div>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="admin-success">
          {notice}
        </p>
      )}
      {loading && <p role="status">Loading team/job data…</p>}
      {tab === "jobs" ? (
        <>
          <section className="admin-panel">
            <h2>Create and allocate a team job</h2>
            <p role="status" className="admin-note">{draftStatus}</p>
            <p>1. Select people and save a reusable team if needed. 2. Configure the job and preview allocations. 3. Confirm to persist assignments and make them available to labellers.</p>
            <fieldset
              disabled={busy || loading}
              className="allocation-controls"
            >
              <div className="admin-grid">
                <label>
                  Job name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    placeholder="Thai linguists — sound classification"
                  />
                </label>
                <label>
                  Team
                  <select
                    value={teamId}
                    onChange={(e) => changeTeam(e.target.value)}
                  >
                    <option value="">
                      Select people from all project workers
                    </option>
                    {catalog.teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.memberIds.length})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Task Definition / version
                  <select
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value)}
                  >
                    <option value="">Choose published protocol</option>
                    {catalog.definitions.flatMap((d) =>
                      Array.from({ length: d.publishedVersion }, (_, i) => (
                        <option key={`${d.id}:${i}`} value={`${d.id}:${i + 1}`}>
                          {d.name} · v{i + 1}
                        </option>
                      )),
                    )}
                  </select>
                </label>
                <label>
                  Dataset
                  <select
                    value={datasetId}
                    onChange={(e) => setDatasetId(e.target.value)}
                  >
                    <option value="">Choose dataset</option>
                    {catalog.datasets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Distribution
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as typeof mode)}
                  >
                    <option value="individual">
                      Individual batch — divide items without overlap
                    </option>
                    <option value="voting">
                      Voting — every selected worker labels the same items
                    </option>
                  </select>
                </label>
                <label>
                  Dataset scope
                  <select value={useEntireDataset?"entire":"sample"} onChange={event=>setUseEntireDataset(event.target.value==="entire")}>
                    <option value="sample">Sample selected items</option>
                    <option value="entire">Entire dataset ({datasetItemCount} items)</option>
                  </select>
                </label>
                <label>
                  {useEntireDataset?"Total dataset items":"Number of items to sample"}
                  <input
                    type="number"
                    min={1}
                    max={useEntireDataset?1000:Math.min(keys.length, 50)}
                    disabled={useEntireDataset}
                    value={effectiveSampleCount}
                    onChange={(e) => setSampleCount(Number(e.target.value))}
                  />
                </label>
                <label>
                  Reproducible shuffle seed
                  <input
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    maxLength={80}
                  />
                </label>
                <div>
                  <button
                    type="button"
                    onClick={() => setSeed(crypto.randomUUID())}
                  >
                    New random seed
                  </button>
                </div>
              </div>
              <h3>Filter and select labellers</h3>
              <div className="admin-grid team-filters">
                <label>
                  Native country
                  <select
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                  >
                    <option value="">All countries</option>
                    {[
                      ...new Set(
                        catalog.workers.map((w) => w.country).filter(Boolean),
                      ),
                    ].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Profession
                  <select
                    value={profession}
                    onChange={(e) => setProfession(e.target.value)}
                  >
                    <option value="">All professions</option>
                    {[
                      ...new Set(
                        catalog.workers
                          .map((w) => w.profession)
                          .filter(Boolean),
                      ),
                    ].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Language
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                  >
                    <option value="">All languages</option>
                    {[
                      ...new Set(catalog.workers.flatMap((w) => w.languages)),
                    ].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Minimum experience (years)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={experience}
                    onChange={(e) => setExperience(Number(e.target.value))}
                  />
                </label>
                <label>
                  Name / other information
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              <p>
                {filtered.length} match filters · {workers.length} selected.
                Filters do not silently change an existing selection.
              </p>
              <button onClick={() => setWorkers(filtered.map((w) => w.userId))}>
                Select all filtered
              </button>{" "}
              <button onClick={() => setWorkers([])}>Clear selected</button>
              <div className="admin-table-scroll allocation-items">
                <table>
                  <thead>
                    <tr>
                      <th>Select</th>
                      <th>Labeller</th>
                      <th>Native country</th>
                      <th>Profession</th>
                      <th>Languages / experience</th>
                      <th>Other information</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((w) => (
                      <tr key={w.userId}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${w.displayName}`}
                            checked={workers.includes(w.userId)}
                            onChange={() =>
                              setWorkers((old) =>
                                old.includes(w.userId)
                                  ? old.filter((id) => id !== w.userId)
                                  : [...old, w.userId],
                              )
                            }
                          />
                        </td>
                        <td>
                          {w.displayName}
                          <small>{w.userId}</small>
                        </td>
                        <td>{w.country}</td>
                        <td>{w.profession}</td>
                        <td>
                          {w.languages.join(", ")} · {w.experienceYears} years
                        </td>
                        <td>
                          {Object.entries(w.metadata)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(" · ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label>
                Save selected workers as a team
                <input
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="Team name"
                  maxLength={120}
                />
              </label>
              <button
                disabled={!teamName || !workers.length}
                onClick={() =>
                  void run(async () => {
                    const saved=await api<{teamId:string}>("worker-profiles?action=team", {
                      projectId,
                      name: teamName,
                      memberIds: workers,
                    });
                    setTeamId(saved.teamId);
                    setRevision((r) => r + 1);
                    setNotice(
                      "Team saved. Existing jobs retain their frozen membership.",
                    );
                  })
                }
              >
                Create team from selection
              </button>
              {teamId && (
                <button
                  disabled={!teamName || !workers.length}
                  onClick={() =>
                    void run(async () => {
                      await api("worker-profiles?action=team", {
                        projectId,
                        teamId,
                        name: teamName,
                        memberIds: workers,
                      });
                      setRevision((r) => r + 1);
                      setNotice(
                        "Team updated for future jobs; launched job snapshots were preserved.",
                      );
                    })
                  }
                >
                  Update selected team
                </button>
              )}
              <h3>Dataset items ({useEntireDataset?`${datasetItemCount} included — entire dataset`:`${keys.length} selected`})</h3>
              <button
                disabled={useEntireDataset}
                onClick={() => {
                  setKeys(items.slice(0, 50).map((i) => i.key));
                  setSampleCount(Math.min(items.length, 50));
                }}
              >
                Select all loaded (up to 50)
              </button>{" "}
              <button disabled={useEntireDataset} onClick={() => setKeys([])}>Clear items</button>
              <div className="admin-table-scroll allocation-items">
                <table>
                  <thead>
                    <tr>
                      <th>Select</th>
                      <th>Item / question</th>
                      <th>Audio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.key}>
                        <td>
                          <input
                            type="checkbox"
                            checked={useEntireDataset||keys.includes(item.key)}
                            aria-label={`Select item ${item.itemId ?? item.recordId ?? item.key}`}
                            disabled={
                              useEntireDataset || (!keys.includes(item.key) && keys.length >= 50)
                            }
                            onChange={() =>
                              setKeys((old) =>
                                old.includes(item.key)
                                  ? old.filter((key) => key !== item.key)
                                  : [...old, item.key],
                              )
                            }
                          />
                        </td>
                        <td>
                          {item.question ??
                            item.itemId ??
                            item.recordId ??
                            "Audio item"}
                          <small>
                            {item.sampleId} · {item.sourceVersion}
                          </small>
                        </td>
                        <td>{item.originalPath}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {cursor && (
                <button
                  onClick={() =>
                    void run(async () => {
                      const data = await api<{
                        items: AllocationItem[];
                        nextCursor: string | null;
                      }>(
                        `team-jobs?action=items&projectId=${projectId}&datasetId=${datasetId}&cursor=${encodeURIComponent(cursor)}`,
                      );
                      setItems((old) => [...old, ...data.items]);
                      setCursor(data.nextCursor);
                    })
                  }
                >
                  Load more items
                </button>
              )}
              <p className="admin-hint">
                {effectiveSampleCount} source items · {recordingsPerTask} recordings per Task Instance.
                {" "}Individual: {Math.ceil(effectiveSampleCount/recordingsPerTask)} worker tasks split across {workers.length} people.
                {" "}Voting: {Math.ceil(effectiveSampleCount/recordingsPerTask)*workers.length} independent assignments over identical batches.
                {" "}The final task uses the remaining recordings with its own smaller NUM_BATCH; no source item is dropped.
              </p>
              <div id="job-preview-requirements" className="admin-note" aria-live="polite">
                {previewProblems.length ? <><strong>Before preview:</strong><ul>{previewProblems.map(problem=><li key={problem}>{problem}</li>)}</ul></> : "Ready to preview. No assignments will be created yet."}
              </div>
              {recordingsPerTask>1 && <p className="admin-note">This published definition uses NUM_BATCH={recordingsPerTask}. It creates {Math.ceil(effectiveSampleCount/recordingsPerTask)} tasks per Voting worker. {effectiveSampleCount%recordingsPerTask>0?`The final task uses NUM_BATCH=${effectiveSampleCount%recordingsPerTask} for the remaining recordings; the published definition stays unchanged.`:"All tasks have a full audio batch."}</p>}
              {previewError && <p role="alert" className="admin-error">{previewError}</p>}
              <button
                className="admin-primary"
                type="button"
                disabled={busy || loading}
                aria-describedby="job-preview-requirements"
                onClick={() => void preview()}
              >
                {busy ? "Preparing preview…" : "Preview team job"}
              </button>
            </fieldset>
            {plan && (
              <div className="allocation-preview" ref={previewPanel}>
                <h3>
                  {plan.items.length} sampled items → {plan.pairs.length} worker
                  assignments ({plan.recordingsPerTask??1} recordings per task)
                </h3>
                {plan.batches && plan.items.length%(plan.recordingsPerTask??1)>0 && <p className="admin-note">Final Task Instance: NUM_BATCH={plan.batches[plan.batches.length-1].itemKeys.length}. All {plan.items.length} source items are included.</p>}
                {plan.batches && <details><summary>Review ordered audio batches ({plan.batches.length})</summary><ol>{plan.batches.map((batch,index)=><li key={batch.key}>Task {index+1}: {batch.itemKeys.map(key=>plan.items.find(item=>item.key===key)?.originalPath??key).join(" → ")}</li>)}</ol></details>}
                <p>
                  Seed: {plan.input.seed}.{" "}
                  {plan.input.mode === "voting"
                    ? "Every worker receives the identical item set."
                    : "Each item appears in exactly one worker’s batch."}
                </p>
                <div className="admin-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Worker</th>
                        <th>Assigned items</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.workers.map((w) => (
                        <tr key={w.userId}>
                          <td>{w.displayName}</td>
                          <td>{plan.counts[w.userId]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details>
                  <summary>Inspect shuffled item order</summary>
                  <ol>
                    {plan.items.map((item) => (
                      <li key={item.key}>
                        {item.question ?? item.itemId ?? item.recordId} ·{" "}
                        {item.originalPath}
                      </li>
                    ))}
                  </ol>
                </details>
                <button
                  className="admin-primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api("team-jobs?action=launch", {
                        ...plan.input,
                        expectedHash: plan.hash,
                      });
                      setPlan(null);
                      setRevision((r) => r + 1);
                      setNotice(
                        "Assignments saved to the database. Labellers can select this job in Workspace.",
                      );
                    })
                  }
                >
                  Confirm & save assignments
                </button>
              </div>
            )}
          </section>
          <section className="admin-panel">
            <h2>Team/job assignment board</h2>
            <div className="admin-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Job / team</th>
                    <th>Task Definition</th>
                    <th>Mode</th>
                    <th>Unique items complete</th>
                    <th>Worker submissions</th>
                    <th>Inspect</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      <td>
                        {job.name}
                        <small>
                          {job.teamName ?? `${job.workers} selected workers`}
                        </small>
                      </td>
                      <td>
                        {job.definitionName} · v{job.definitionVersion}
                      </td>
                      <td>{job.mode}</td>
                      <td>
                        {job.fullyLabelledItems}/{job.items}
                      </td>
                      <td>
                        {job.submitted}/{job.assignments}
                      </td>
                      <td>
                        <button onClick={() => setOpenJob(job.id)}>
                          Progress & tasks
                        </button>
                        <button type="button" disabled={busy} onClick={()=>{
                          if(window.confirm(`Delete job “${job.name}” from active boards and worker queues? Saved annotations and audit history will be retained.`))void run(async()=>{
                            await api("team-jobs?action=delete",{projectId,jobId:job.id});setRevision(value=>value+1);setNotice("Job deleted from active boards and queues. Annotation history is retained.");
                          });
                        }}>Delete job</button>
                        {!job.launchedAt && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const saved = await api<{ plan: JobPlan }>(
                                  `team-jobs?action=detail&projectId=${projectId}&jobId=${job.id}`,
                                );
                                await api("team-jobs?action=launch", {
                                  ...saved.plan.input,
                                  expectedHash: saved.plan.hash,
                                });
                                setRevision((r) => r + 1);
                                setNotice("Saved job launch resumed safely.");
                              })
                            }
                          >
                            Retry launch
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!jobs.length && (
              <p>
                No team jobs yet. Existing standalone assignments remain in
                their workers’ queues.
              </p>
            )}
          </section>
        </>
      ) : (
        <section className="admin-panel">
          <h2>Teams and worker profiles</h2>
          <p>
            Profile fields support filtering; project membership supplies
            permission. Accounts are provisioned separately, rather than
            granting roles from a profile form.
          </p>
          <div className="admin-grid">
            <div>
              {catalog.teams.map((t) => (
                <div className="admin-member" key={t.id}>
                  <span>
                    <b>{t.name}</b>
                    <small>{t.memberIds.length} members</small>
                  </span>
                  <button
                    onClick={() => {
                      changeTeam(t.id);
                      setTeamName(t.name);
                      setTab("jobs");
                    }}
                  >
                    Use team
                  </button>
                </div>
              ))}
              <h3>Project labellers</h3>
              {catalog.workers.map((w) => (
                <div className="admin-member" key={w.userId}>
                  <span>
                    {w.displayName}
                    <small>
                      {w.country} · {w.profession}
                    </small>
                  </span>
                  <button
                    onClick={() => {
                      setProfile({ ...w });
                      setLanguageText(w.languages.join(", "));
                      setMetadata(JSON.stringify(w.metadata, null, 2));
                    }}
                  >
                    Edit profile
                  </button>
                </div>
              ))}
            </div>
            {profile && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const parsed: unknown = JSON.parse(metadata);
                    await api("worker-profiles", {
                      userId: profile.userId,
                      country: profile.country,
                      profession: profile.profession,
                      experienceYears: profile.experienceYears,
                      active: profile.active,
                      languages: languageText
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                      projectId,
                      metadata: parsed,
                    });
                    setProfile(null);
                    setRevision((r) => r + 1);
                    setNotice(
                      "Profile saved. Existing job snapshots were preserved.",
                    );
                  });
                }}
              >
                <h3>{profile.displayName}</h3>
                <label>
                  Native country
                  <input
                    value={profile.country}
                    onChange={(e) =>
                      setProfile({ ...profile, country: e.target.value })
                    }
                  />
                </label>
                <label>
                  Profession
                  <input
                    value={profile.profession}
                    onChange={(e) =>
                      setProfile({ ...profile, profession: e.target.value })
                    }
                  />
                </label>
                <label>
                  Languages (comma separated)
                  <input
                    value={languageText}
                    onChange={(e) => setLanguageText(e.target.value)}
                  />
                </label>
                <label>
                  Experience years
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={profile.experienceYears}
                    onChange={(e) =>
                      setProfile({
                        ...profile,
                        experienceYears: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="allocation-check">
                  <input
                    type="checkbox"
                    checked={profile.active}
                    onChange={(e) =>
                      setProfile({ ...profile, active: e.target.checked })
                    }
                  />
                  Eligible for new jobs
                </label>
                <label>
                  Other information (JSON object of text values)
                  <textarea
                    value={metadata}
                    onChange={(e) => setMetadata(e.target.value)}
                  />
                </label>
                <button disabled={busy} className="admin-primary">
                  Save profile
                </button>
              </form>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
