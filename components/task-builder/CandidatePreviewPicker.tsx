"use client";
import { useEffect, useRef, useState } from "react";
import type { Block } from "./model";
import type { CandidateSetView } from "@/lib/contracts/candidate-sets";
import {
  getAssignmentDetail,
  withCandidateSets,
} from "@/lib/frontend/labeller-api";

/** Preview real owner-projected sets without writing votes or storing sample IDs in the definition. */
export default function CandidatePreviewPicker({
  projectId,
  blocks,
  onChange,
}: {
  projectId: string;
  blocks: Block[];
  onChange: (sets: Record<string, CandidateSetView>) => void;
}) {
  const [assignmentId, setAssignmentId] = useState("");
  const [worker, setWorker] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  // Project/definition switches unmount this keyed picker. Abort stale reads so
  // a previous project's sample can never populate the new form's preview.
  useEffect(() => () => pending.current?.abort(), []);
  async function load() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    onChange({});
    try {
      const detail = await getAssignmentDetail(
        assignmentId.trim(),
        controller.signal,
      );
      if (
        detail.assignment.projectId !== projectId ||
        detail.assignment.labellerId !== worker.trim()
      )
        throw new Error(
          "Select an assignment owned by this worker in the current project.",
        );
      const loaded = await withCandidateSets(
        detail,
        worker.trim(),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const samples = loaded.taskInstance.candidateSets ?? {};
      if (!blocks.every((block) => samples[block.id]))
        throw new Error(
          "Choose a prepared assignment using these same published block IDs.",
        );
      const mapped: Record<string, CandidateSetView> = {};
      blocks.forEach((block) => {
        mapped[block.id] = { ...samples[block.id], closed: false };
      });
      onChange(mapped);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load preview candidates.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="tb-panel">
      <h3>Preview saved candidates</h3>
      <p>
        Load a real voting assignment. Preview choices are temporary and do not
        submit a vote.
      </p>
      <label className="tb-field">
        Assignment ID
        <input
          disabled={busy}
          value={assignmentId}
          onChange={(e) => setAssignmentId(e.target.value)}
        />
      </label>
      <label className="tb-field">
        Local worker ID
        <input
          disabled={busy}
          value={worker}
          onChange={(e) => setWorker(e.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !assignmentId.trim() || !worker.trim()}
        onClick={() => void load()}
      >
        {busy ? "Loading candidates…" : "Load saved candidates"}
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
