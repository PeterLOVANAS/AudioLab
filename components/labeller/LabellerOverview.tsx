"use client";
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  FilePenLine,
  Headphones,
  ListChecks,
} from "lucide-react";

type Counts = {
  total: number;
  assigned: number;
  inProgress: number;
  submitted: number;
  reviewed: number;
  drafts: number;
};
type Recent = {
  id: string;
  definitionName: string;
  status: string;
  assignedAt: string;
  submittedAt: string | null;
};

type Props = {
  projectId: string;
  labellerId: string;
  labellerName: string;
  onOpenWorkspace: () => void;
  onOpenAssignment: (id: string) => void;
};
export default function LabellerOverview({
  projectId,
  labellerId,
  labellerName,
  onOpenWorkspace,
  onOpenAssignment,
}: Props) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCounts(null);
    setError("");
    const params = new URLSearchParams({ projectId, labellerId });
    fetch(`/api/v1/labeller/overview?${params}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const data = (await response.json()) as {
          error?: string;
          counts?: Counts;
          recent?: Recent[];
        };
        if (!response.ok || !data.counts)
          throw new Error(data.error ?? `Overview HTTP ${response.status}`);
        return data;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setCounts(data.counts ?? null);
        setRecent(data.recent ?? []);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(String(error));
      });
    return () => controller.abort();
  }, [projectId, labellerId, refresh]);

  const finished = (counts?.submitted ?? 0) + (counts?.reviewed ?? 0);
  const total = counts?.total ?? 0;
  const completion = total ? Math.round((finished / total) * 100) : 0;
  const stats = [
    { label: "Total assigned", count: counts?.total, icon: ListChecks },
    { label: "Completed", count: finished, icon: CheckCircle2 },
    { label: "Drafts saved", count: counts?.drafts, icon: FilePenLine },
    {
      label: "Remaining",
      count: (counts?.assigned ?? 0) + (counts?.inProgress ?? 0),
      icon: Clock3,
    },
  ];
  return (
    <div className="alw3-mode">
      <div className="alw3-header">
        <div>
          <span className="al-eyebrow">LABELLER MODE · MY PROGRESS</span>
          <h1>Welcome, {labellerName}</h1>
          <p>Track your own annotations and continue an unfinished task.</p>
        </div>
        <button
          className="alw3-primary"
          type="button"
          onClick={onOpenWorkspace}
        >
          <Headphones size={17} /> Open workspace
        </button>
      </div>
      {error && (
        <div className="alw3-error" role="alert">
          {error}
          <button type="button" onClick={() => setRefresh((v) => v + 1)}>
            Retry
          </button>
        </div>
      )}
      <section
        className="alw3-stat-grid"
        aria-label="Labeller progress metrics"
      >
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <article className="alw3-stat" key={stat.label}>
              <div className="alw3-stat-label">
                <span>{stat.label}</span>
                <Icon size={20} />
              </div>
              <strong>{counts ? stat.count : "—"}</strong>
            </article>
          );
        })}
      </section>
      <section className="alw3-panel alw3-progress">
        <div className="alw3-row-split">
          <div>
            <h2>Overall completion</h2>
            <p>
              {counts
                ? `${finished} of ${total} assignments completed`
                : "Loading progress…"}
            </p>
          </div>
          <strong>{counts ? `${completion}%` : "—"}</strong>
        </div>
        <progress
          value={finished}
          max={Math.max(1, total)}
          aria-label="Completed assignments"
        />
        <p className="alw3-muted">
          Statistics come from the assignment and annotation-revision database,
          not browser-only counters.
        </p>
      </section>
      <section className="alw3-panel">
        <div className="alw3-row-split">
          <h2>Recent work</h2>
          <button
            type="button"
            className="alw3-secondary"
            onClick={() => setRefresh((v) => v + 1)}
          >
            Refresh
          </button>
        </div>
        {recent.length === 0 ? (
          <p className="alw3-muted">
            No annotation activity yet. Open Workspace to begin.
          </p>
        ) : (
          <div className="alw3-recent">
            {recent.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => onOpenAssignment(row.id)}
              >
                <span>
                  <strong>{row.definitionName}</strong>
                  <small>
                    {row.assignedAt} · {row.id.slice(0, 8)}
                  </small>
                </span>
                <span className="alw3-status">
                  {row.status.replaceAll("_", " ")}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <p className="alw3-dev-note">
        Development identities are selected locally. The real deployment must
        use an authenticated user session.
      </p>
    </div>
  );
}
