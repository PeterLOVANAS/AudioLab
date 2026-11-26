"use client";
import { useEffect, useState } from "react";
import {
  FolderKanban,
  Users,
  CheckCheck,
  ListChecks,
  Database,
  AudioLines,
  RefreshCw,
  ArrowUpRight,
} from "lucide-react";
import { adminRequest as api } from "@/lib/frontend/admin-api";
import type { ResearchOverview as OverviewData } from "@/lib/contracts/research-overview";
import "./research-overview.css";
/** Server counts own the dashboard; project buttons change the existing app
 * context rather than create a second progress/assignment UI. Refresh is explicit
 * and canceled loads cannot replace another project's state.
 */
export default function ResearchOverview({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (
    projectId: string,
    page: "team" | "progress" | "exports" | "settings",
  ) => void;
}) {
  const [data, setData] = useState<OverviewData | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setData(null);
    setError("");
    if (!projectId) {
      setLoading(false);
      return () => abort.abort();
    }
    setLoading(true);
    api<OverviewData>(
      `research-overview?projectId=${projectId}`,
      undefined,
      abort.signal,
    )
      .then((value) => {
        if (!abort.signal.aborted) setData(value);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(String(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [projectId, refresh]);
  const cards = data
    ? [
        {
          label: "Research projects",
          value: data.totals.projects,
          note: `${data.totals.datasets} datasets · ${data.totals.audioFiles} recordings`,
          icon: FolderKanban,
          tone: "violet",
        },
        {
          label: "Annotation jobs",
          value: data.totals.jobs,
          note: "Active-list jobs across your admin projects",
          icon: Users,
          tone: "blue",
        },
        {
          label: "Submitted assignments",
          value: data.totals.submitted,
          note: `of ${data.totals.assignments} individual worker assignments`,
          icon: CheckCheck,
          tone: "green",
        },
        {
          label: "Fully labelled source items",
          value: data.totals.completedSourceItems,
          note: `of ${data.totals.sourceItems} distinct assigned items`,
          icon: ListChecks,
          tone: "amber",
        },
      ]
    : [];
  return (
    <div className="research-overview">
      <div className="ro-toolbar">
        <p>
          Operations across projects you administer. Worker submissions and
          unique source-item completion are counted separately.
        </p>
        <button
          className="ro-button"
          disabled={loading || !projectId}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={16} />
          Refresh statistics
        </button>
      </div>
      {!projectId && (
        <section className="al-panel">
          Choose an authorized project to load statistics.
        </section>
      )}
      {loading && (
        <section className="al-panel" role="status">
          Loading project statistics…
        </section>
      )}
      {error && (
        <section className="ro-error" role="alert">
          {error}
        </section>
      )}
      {data && (
        <>
          <div className="ro-stats">
            {cards.map((card) => (
              <article className="al-panel ro-stat" key={card.label}>
                <div className="ro-stat-title">
                  <span>{card.label}</span>
                  <span className={`ro-icon ro-${card.tone}`}>
                    <card.icon size={22} />
                  </span>
                </div>
                <strong>{card.value.toLocaleString()}</strong>
                <small>{card.note}</small>
              </article>
            ))}
          </div>
          <section className="al-panel">
            <div className="ro-toolbar">
              <h2>Your project portfolio</h2>
              <small>Updated {new Date(data.asOf).toLocaleString()}</small>
            </div>
            {!data.projects.length && <p>No admin projects available.</p>}
            <div className="ro-projects">
              {data.projects.map((project) => (
                <article className="ro-project" key={project.id}>
                  <div className="ro-toolbar">
                    <div className="ro-project-name">
                      <span className="ro-icon ro-violet">
                        <FolderKanban size={22} />
                      </span>
                      <div>
                        <h3>{project.name}</h3>
                        <small>/{project.slug}</small>
                      </div>
                    </div>
                    <span className={`ro-status ro-status-${project.status}`}>
                      {project.status === "setup"
                        ? "Setup"
                        : project.status === "complete"
                          ? "Complete"
                          : "In progress"}
                    </span>
                  </div>
                  <div className="ro-progress-label">
                    <strong>
                      {project.completedSourceItems}/{project.sourceItems}{" "}
                      unique source items fully labelled
                    </strong>
                    <span>
                      {project.sourceItems
                        ? `${Math.round((project.completedSourceItems / project.sourceItems) * 100)}%`
                        : "No assignments yet"}
                    </span>
                  </div>
                  <progress
                    max={project.sourceItems || 1}
                    value={project.completedSourceItems}
                    aria-label={`${project.name} source item completion`}
                  />
                  <div className="ro-project-metrics">
                    <span>
                      <Database size={16} />
                      {project.datasets} datasets
                    </span>
                    <span>
                      <AudioLines size={16} />
                      {project.audioFiles} recordings
                    </span>
                    <span>
                      <Users size={16} />
                      {project.labellers} labellers
                    </span>
                    <span>{project.definitions} Task Definitions</span>
                  </div>
                  <p>
                    {project.submitted}/{project.assignments} worker assignments
                    submitted · {project.inProgress} in progress ·{" "}
                    {project.pending} not started · {project.completedJobs}/
                    {project.jobs} jobs complete.
                  </p>
                  <p className="ro-hint">
                    {project.lastSubmittedAt
                      ? `Latest submission: ${new Date(/(Z|[+-]\d{2}:\d{2})$/.test(project.lastSubmittedAt) ? project.lastSubmittedAt : project.lastSubmittedAt.replace(" ", "T") + "Z").toLocaleString()}`
                      : "No submitted assignments yet."}
                  </p>
                  <div className="ro-actions">
                    {(["team", "progress", "exports", "settings"] as const).map(
                      (page) => (
                        <button
                          className="ro-button"
                          key={page}
                          onClick={() => onOpen(project.id, page)}
                        >
                          {
                            {
                              team: "Assignments",
                              progress: "Progress",
                              exports: "Exports",
                              settings: "Configuration",
                            }[page]
                          }
                          <ArrowUpRight size={14} />
                        </button>
                      ),
                    )}
                  </div>
                </article>
              ))}
            </div>
            <p className="ro-hint">
              Source items may be separate questions sharing one recording. An
              item is complete only after all active assignments for it are
              submitted. Deleted jobs are excluded. This is annotation
              completion, not accepted review output or reference accuracy.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
