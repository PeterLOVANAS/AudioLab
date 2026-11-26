"use client";

import { useState } from "react";
import LabellerWorkspace from "@/components/labeller/LabellerWorkspace";
import SavedTaskWorkspace from "@/components/labeller/SavedTaskWorkspace";

/**
 * The role toggle in the main app should link to /labeller/workspace.
 * Within that role, definitions and real assignments are TWO data sources.
 * A saved DB definition should not be hidden because the assignment queue is
 * empty; conversely, the test view must never claim its answers were submitted.
 */
export default function WorkspaceEntry({
  projectId,
  labellerId,
  initialView,
}: {
  projectId: string;
  labellerId: string;
  initialView?: "saved" | "assigned";
}) {
  const [view, setView] = useState<"saved" | "assigned">(
    initialView ?? "saved",
  );
  return (
    <div>
      <nav
        aria-label="Labeller workspace sections"
        style={{
          display: "flex",
          gap: "0.75rem",
          padding: "0.75rem 1rem",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong>Labeller Mode</strong>
        <button
          type="button"
          aria-pressed={view === "saved"}
          onClick={() => setView("saved")}
        >
          Saved Builder tasks
        </button>
        <button
          type="button"
          aria-pressed={view === "assigned"}
          onClick={() => setView("assigned")}
        >
          My assigned queue
        </button>
        <span style={{ fontSize: "0.8rem", opacity: 0.7 }}>
          {labellerId || "No member selected"}
        </span>
      </nav>
      {view === "saved" ? (
        <SavedTaskWorkspace
          projectId={projectId}
          labellerId={labellerId}
          onAssigned={() => setView("assigned")}
        />
      ) : (
        <LabellerWorkspace projectId={projectId} labellerId={labellerId} />
      )}
    </div>
  );
}
