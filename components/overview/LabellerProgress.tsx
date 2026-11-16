"use client";
/**
 * LabellerProgress — Feature 2
 *
 * Rendered inside the admin overview page (page === "overview", role === "admin").
 * Mirrors the prototype's overview stat-grid + project task activity table.
 *
 * Data sources (existing main-branch APIs):
 *   GET /api/v1/task-instances?projectId=   — task counts
 *   GET /api/v1/project-members?projectId=  — labeller list
 *   GET /api/v1/assignments?projectId=      — per-labeller assignment counts
 */
import { useEffect, useState } from "react";
import {
  Database,
  CheckCircle2,
  ShieldCheck,
  Headphones,
  Users,
  RefreshCw,
} from "lucide-react";
import StatCard from "@/components/overview/StatCard";

// ─── types ───────────────────────────────────────────────────────────────────

type TaskInstance = {
  id: string;
  definitionName?: string;
  status?: string;
  definitionId?: string;
};

type Member = {
  userId: string;
  displayName: string;
  role: string;
};

type Assignment = {
  id: string;
  labellerId?: string;
  labeller_user_id?: string;
  status: string;
  taskInstanceId?: string;
};

type LabellerRow = {
  userId: string;
  displayName: string;
  total: number;
  submitted: number;
  inProgress: number;
  assigned: number;
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function statusTone(status: string) {
  if (status === "submitted" || status === "reviewed") return "green";
  if (status === "in_progress") return "amber";
  return "";
}

function Badge({
  children,
  tone = "",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <span className={`al-cfg-badge ${tone ? `al-cfg-badge-${tone}` : ""}`}>
      {children}
    </span>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

type Props = {
  projectId: string;
};

export default function LabellerProgress({ projectId }: Props) {
  const [instances, setInstances] = useState<TaskInstance[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setError("");

    const params = new URLSearchParams({ projectId });

    Promise.all([
      fetch(`/api/v1/task-instances?${params}`, {
        cache: "no-store",
      }).then((r) =>
        r.json() as Promise<{ instances?: TaskInstance[]; error?: string }>,
      ),
      fetch(`/api/v1/project-members?${params}`, {
        cache: "no-store",
      }).then((r) =>
        r.json() as Promise<{ members?: Member[]; error?: string }>,
      ),
      fetch(`/api/v1/assignments?${params}`, {
        cache: "no-store",
      }).then((r) =>
        r.json() as Promise<{ assignments?: Assignment[]; error?: string }>,
      ),
    ])
      .then(([instData, memberData, assignData]) => {
        setInstances(instData.instances ?? []);
        setMembers((memberData.members ?? []).filter((m) => m.role === "labeller"));
        setAssignments(assignData.assignments ?? []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectId, tick]);

  // ── Aggregate stats ──────────────────────────────────────────────────────

  const totalTasks = instances.length;

  const submittedAssignments = assignments.filter(
    (a) => a.status === "submitted" || a.status === "reviewed",
  ).length;

  const draftAssignments = assignments.filter(
    (a) => a.status === "in_progress",
  ).length;

  const remainingAssignments = assignments.filter(
    (a) => a.status === "assigned",
  ).length;

  // ── Per-labeller rows ────────────────────────────────────────────────────

  const labellerRows: LabellerRow[] = members.map((m) => {
    const myAssignments = assignments.filter(
      (a) =>
        (a.labellerId ?? (a as unknown as Record<string, string>)["labeller_user_id"]) ===
        m.userId,
    );
    return {
      userId: m.userId,
      displayName: m.displayName,
      total: myAssignments.length,
      submitted: myAssignments.filter(
        (a) => a.status === "submitted" || a.status === "reviewed",
      ).length,
      inProgress: myAssignments.filter((a) => a.status === "in_progress")
        .length,
      assigned: myAssignments.filter((a) => a.status === "assigned").length,
    };
  });

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="al-cfg-hint" style={{ padding: "2rem" }}>
        Loading project statistics…
      </div>
    );
  }

  return (
    <div className="al-progress-root">
      {error && (
        <div className="al-cfg-error" role="alert">
          {error}
          <button type="button" onClick={() => setTick((v) => v + 1)}>
            Retry
          </button>
        </div>
      )}

      {/* ── Top stat cards ── */}
      <section
        className="al-stat-grid"
        aria-label="Research overview statistics"
      >
        <StatCard
          label="Annotation tasks"
          value={totalTasks}
          note={
            totalTasks === 0
              ? "No research tasks imported yet"
              : `${totalTasks} task instances in this project`
          }
          icon={Database}
        />
        <StatCard
          label="Verified tasks"
          value={submittedAssignments}
          note="Reviewed or policy-approved"
          icon={CheckCircle2}
        />
        <StatCard
          label="Awaiting review"
          value={draftAssignments}
          note="Independent evidence ready"
          icon={ShieldCheck}
        />
        <StatCard
          label="Remaining tasks"
          value={remainingAssignments}
          note="Available or assigned to labellers"
          icon={Headphones}
        />
      </section>

      {/* ── Project task activity table ── */}
      {instances.length > 0 && (
        <section className="al-panel al-progress-panel">
          <div className="al-cfg-heading">
            <h2>Project task activity</h2>
            <Badge>{instances.length} tasks</Badge>
          </div>
          <div className="al-progress-scroll">
            <table className="al-progress-table">
              <thead>
                <tr>
                  <th>Task ID</th>
                  <th>Definition</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {instances.slice(0, 12).map((t) => (
                  <tr key={t.id}>
                    <td className="al-progress-mono">{t.id.slice(0, 12)}…</td>
                    <td>{t.definitionName ?? t.definitionId ?? "—"}</td>
                    <td>
                      <Badge tone={statusTone(t.status ?? "")}>
                        {(t.status ?? "unknown").replace(/_/g, " ")}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Per-labeller progress ── */}
      <section className="al-panel al-progress-panel">
        <div className="al-cfg-heading">
          <div>
            <span className="al-eyebrow">LABELLER PROGRESS</span>
            <h2>Per-labeller status</h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Badge>{members.length} labellers</Badge>
            <button
              className="al-cfg-btn-icon"
              title="Refresh"
              aria-label="Refresh labeller progress"
              onClick={() => setTick((v) => v + 1)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </div>

        {labellerRows.length === 0 ? (
          <div className="al-progress-empty">
            <Users size={28} />
            <p>No labellers registered for this project.</p>
            <small>
              Add labellers via Team &amp; assignments to see per-person
              progress here.
            </small>
          </div>
        ) : (
          <div className="al-progress-scroll">
            <table className="al-progress-table">
              <thead>
                <tr>
                  <th>Labeller</th>
                  <th>Assigned</th>
                  <th>Submitted</th>
                  <th>In progress</th>
                  <th>Remaining</th>
                  <th>Completion</th>
                </tr>
              </thead>
              <tbody>
                {labellerRows.map((row) => {
                  const pct = row.total
                    ? Math.round((row.submitted / row.total) * 100)
                    : 0;
                  return (
                    <tr key={row.userId}>
                      <td>
                        <strong>{row.displayName}</strong>
                        <small
                          style={{
                            display: "block",
                            color: "var(--al-muted, #8898aa)",
                            fontSize: "11px",
                          }}
                        >
                          {row.userId.slice(0, 14)}…
                        </small>
                      </td>
                      <td>{row.total}</td>
                      <td>
                        <Badge tone={row.submitted > 0 ? "green" : ""}>
                          {row.submitted}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={row.inProgress > 0 ? "amber" : ""}>
                          {row.inProgress}
                        </Badge>
                      </td>
                      <td>{row.assigned}</td>
                      <td>
                        <div className="al-progress-bar-wrap">
                          <progress
                            value={row.submitted}
                            max={Math.max(1, row.total)}
                            aria-label={`${row.displayName} completion`}
                          />
                          <small>{pct}%</small>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
