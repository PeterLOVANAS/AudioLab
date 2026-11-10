import WorkspaceEntry from "@/components/labeller/WorkspaceEntry";
import "@/components/task-builder/task-builder.css";
import "@/components/labeller/labeller-workspace.css";

/**
 * Labeller entry. Default to DB-SAVED Builder tasks, so an empty assignment
 * queue cannot hide a task that the Builder has saved successfully.
 *
 * Real assignments remain available via ?view=assigned. Current labellerId
 * is a DEV-ONLY identity, not authentication.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    projectId?: string | string[];
    labellerId?: string | string[];
    view?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const projectId =
    typeof params.projectId === "string" ? params.projectId : "";
  const labellerId =
    typeof params.labellerId === "string" ? params.labellerId : "";
  return (
    <WorkspaceEntry
      projectId={projectId}
      labellerId={labellerId}
      initialView={params.view === "assigned" ? "assigned" : "saved"}
    />
  );
}
