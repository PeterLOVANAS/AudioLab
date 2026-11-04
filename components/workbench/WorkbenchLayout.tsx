import type { ReactNode } from "react";

// Teammates can provide their components here without editing the question renderer.
export default function WorkbenchLayout({
  name,
  instructions,
  queue,
  grounding,
  children,
}: {
  name: string;
  instructions: string;
  queue: ReactNode;
  grounding: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="tb-workbench">
      <aside className="tb-panel tb-queue" aria-label="Task queue">
        {queue}
      </aside>
      <div className="tb-stack">
        <section className="tb-panel">
          <p className="tb-eyebrow">TASK INSTRUCTIONS</p>
          <h2>{name || "Untitled task"}</h2>
          <p className="tb-instructions">{instructions || "Instructions will appear here."}</p>
        </section>
        {grounding}
        <section className="tb-panel">
          <p className="tb-eyebrow">ANNOTATION</p>
          <h2>Task questions</h2>
          {children}
        </section>
      </div>
    </div>
  );
}
