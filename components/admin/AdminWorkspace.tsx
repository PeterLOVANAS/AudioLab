"use client";
import { useEffect, useState } from "react";
import { adminRequest as api } from "@/lib/frontend/admin-api";
import TeamJobsWorkspace from "./TeamJobsWorkspace";
import TeamJobProgress from "./TeamJobProgress";
import "./admin.css";
/** Team/job boards replace the old member/job/individual-allocation panels.
 * Existing per-worker services remain the persistence layer underneath them.
 */
export default function AdminWorkspace({
  projectId,
  progress = false,
  draftOwnerId = "",
  projects = [],
  initialDatasetId = "",
  onChooseDataset,
}: {
  projectId: string;
  progress?: boolean;
  draftOwnerId?: string;
  projects?:Array<{id:string;name:string}>;
  initialDatasetId?:string;
  onChooseDataset?:(projectId:string,datasetId:string)=>void;
  onMembersChanged?: () => void;
}) {
  const [available,setAvailable]=useState<Array<{id:string;name:string;projectId:string;projectName:string}>>([]);
  const [datasetError,setDatasetError]=useState("");
  // Discovery spans only admin memberships supplied by the verified session.
  // Choosing a dataset changes project scope; definitions/workers remain scoped.
  const projectKey=JSON.stringify(projects);
  useEffect(()=>{
    const abort=new AbortController();
    const rows=JSON.parse(projectKey) as Array<{id:string;name:string}>;
    Promise.all(rows.map(async project=>{
      const result=await api<{datasets:Array<{id:string;name:string}>}>(`datasets?projectId=${project.id}`,undefined,abort.signal);
      return result.datasets.map(dataset=>({...dataset,projectId:project.id,projectName:project.name}));
    })).then(groups=>{if(!abort.signal.aborted){setAvailable(groups.flat());setDatasetError("");}})
    .catch(reason=>{if(!abort.signal.aborted)setDatasetError(String(reason));});
    return ()=>abort.abort();
  },[projectKey]);
  if (!projectId)
    return (
      <section className="al-panel">Choose an authorized project.</section>
    );
  return <>
    {!progress && onChooseDataset && <section className="admin-workspace"><div className="admin-panel">
      <label>Open dataset from your projects
        <select aria-label="Open dataset from your projects" value="" onChange={event=>{
          const dataset=available.find(row=>row.id===event.target.value);
          if(dataset)onChooseDataset(dataset.projectId,dataset.id);
        }}>
          <option value="">Choose a dataset — switches to its project</option>
          {available.map(dataset=><option key={dataset.id} value={dataset.id}>{dataset.name} — {dataset.projectName}</option>)}
        </select>
      </label>
      <p>Current project: {projects.find(project=>project.id===projectId)?.name ?? projectId}. Task Definitions and workers must belong to this project.</p>
      {datasetError && <p role="alert" className="admin-error">{datasetError}</p>}
    </div></section>}
    {progress ? (
    <TeamJobProgress key={projectId} projectId={projectId} />
  ) : (
    <TeamJobsWorkspace key={projectId} projectId={projectId} draftOwnerId={draftOwnerId} initialDatasetId={initialDatasetId} />
  )}
  </>;
}
