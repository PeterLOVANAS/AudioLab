"use client";
import { useState } from "react";
import type { TaskInstancePreview } from "@/lib/contracts/task-instances";
import type { ProjectMemberRecord } from "@/lib/contracts/assignment-api";
import type {
  CandidateSourceOption,
  CandidateResult,
} from "@/lib/contracts/candidate-sets";
import { candidateText } from "@/lib/frontend/candidate-voting";
import { adminRequest as api } from "@/lib/frontend/admin-api";

/**
 * Curates per-job sources, not hard-coded template answers. Source IDs/values
 * come from the admin-scoped inventory; the server revalidates every reference.
 * Successful backend responses alone set saved/result state. A fixed request key
 * makes network retries idempotent; editing a frozen set requires a new job.
 */
export default function CandidateSetManager({
  task,
  members,
}: {
  task: TaskInstancePreview;
  members: ProjectMemberRecord[];
}) {
  const blocks = task.definition.blocks.filter(
    (b) => b.type === "candidate_vote" && b.candidateSource === "set",
  );
  const [admin, setAdmin] = useState("");
  const [blockId, setBlockId] = useState(blocks[0]?.id ?? "");
  const [sources, setSources] = useState<CandidateSourceOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [setId, setSetId] = useState("");
  const [result, setResult] = useState<CandidateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [requestId, setRequestId] = useState("");
  if (!blocks.length) return null;
  const key = (option: CandidateSourceOption) => JSON.stringify(option.source);
  function reset() {
    setSources([]);
    setSelected([]);
    setSetId("");
    setResult(null);
    setNotice("");
    setError("");
    setRequestId("");
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Candidate operation failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function load() {
    const query = new URLSearchParams({
      projectId: task.projectId,
      userId: admin,
      taskInstanceId: task.id,
      blockId,
    });
    const inventory = await api<{
      sources: CandidateSourceOption[];
      candidateSet: { id: string } | null;
    }>(`candidate-sets/sources?${query}`);
    setSources(inventory.sources);
    setSelected([]);
    setSetId(inventory.candidateSet?.id ?? "");
    setRequestId(crypto.randomUUID());
    setResult(null);
    setNotice(
      inventory.candidateSet
        ? "This job's candidate set is already saved and immutable."
        : "Choose 2–20 comparable candidate answers.",
    );
  }
  return (
    <section className="admin-panel">
      <h3>Candidate voting</h3>
      <label>
        Local project admin
        <select
          value={admin}
          disabled={busy}
          onChange={(e) => {
            reset();
            setAdmin(e.target.value);
          }}
        >
          <option value="">Select admin</option>
          {members
            .filter((m) => m.role === "admin")
            .map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
        </select>
      </label>
      <label>
        Voting block
        <select
          value={blockId}
          disabled={busy}
          onChange={(e) => {
            reset();
            setBlockId(e.target.value);
          }}
        >
          {blocks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy || !admin} onClick={() => void run(load)}>
        Load candidate sources
      </button>
      {!!sources.length && !setId && (
        <fieldset disabled={busy}>
          <legend>Stored source answers</legend>
          {sources.map((option) => (
            <label key={key(option)}>
              <input
                type="checkbox"
                checked={selected.includes(key(option))}
                onChange={(e) =>
                  setSelected((old) =>
                    e.target.checked
                      ? [...old, key(option)]
                      : old.filter((id) => id !== key(option)),
                  )
                }
              />
              {option.label}:{" "}
              <span style={{ whiteSpace: "pre-wrap" }}>
                {candidateText(option.value)}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {!sources.length && notice && !setId && (
        <p>
          No supported sources found. Complete earlier annotations or import
          early annotations for this exact recording/source.
        </p>
      )}
      <button
        disabled={
          busy ||
          !admin ||
          !requestId ||
          !!setId ||
          selected.length < 2 ||
          selected.length > 20
        }
        onClick={() =>
          void run(async () => {
            const response = await api<{ candidateSet: { id: string } }>(
              "candidate-sets",
              {
                projectId: task.projectId,
                taskInstanceId: task.id,
                blockId,
                userId: admin,
                requestId,
                sources: sources
                  .filter((option) => selected.includes(key(option)))
                  .map((option) => option.source),
              },
            );
            setSetId(response.candidateSet.id);
            setNotice("Candidate set saved. Assigned labellers can now vote.");
          })
        }
      >
        Save candidate set
      </button>
      {setId && (
        <button
          disabled={busy || !admin || result?.status === "accepted"}
          onClick={() =>
            void run(async () => {
              const response = await api<{ result: CandidateResult }>(
                `candidate-sets/${setId}/result`,
                { projectId: task.projectId, userId: admin },
              );
              setResult(response.result);
              setNotice(
                response.result.status === "accepted"
                  ? "Accepted result saved; voting is closed."
                  : "Result recorded; no candidate accepted yet.",
              );
            })
          }
        >
          Calculate and record result
        </button>
      )}
      {result && (
        <div role="status">
          <p>
            {result.status.replaceAll("_", " ")} · {result.totalVotes}/
            {result.policy.minimumVotes} minimum votes
          </p>
          <ul>
            {Object.entries(result.counts).map(([id, count], index) => (
              <li key={id}>
                Candidate {index + 1}: {count} votes
              </li>
            ))}
          </ul>
          {result.accepted && (
            <p>
              Accepted: {candidateText(result.accepted.value)} · Result ID:{" "}
              {result.id}
            </p>
          )}
        </div>
      )}
      {busy && <p role="status">Updating candidate voting…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
