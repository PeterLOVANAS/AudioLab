"use client"; // This directive indicates that the file is a client-side component in Next.js, meaning it will be rendered on the client side rather than the server side. It allows the use of React hooks and other client-side features.

import { useEffect, useState } from "react"; // Importing the useState hook from React, which allows us to manage state in functional components.

import { Menu, ChevronRight } from "lucide-react"; // Importing specific icons from the lucide-react library, which provides a collection of SVG icons for React applications.

import Sidebar, { type PageId } from "@/components/layout/Sidebar"; // Importing the Sidebar component and the PageId type from a local file. The Sidebar component is likely a custom component for navigation, and PageId is a type definition for page identifiers.

import ProjectConfiguration from "@/components/overview/ProjectConfiguration";
import ResearchOverview from "@/components/overview/ResearchOverview";
import TaskBuilder from "@/components/task-builder/TaskBuilder";
import ResearchExportWorkspace from "@/components/admin/ResearchExportWorkspace";
import AdminWorkspace from "@/components/admin/AdminWorkspace";
import type { UserRole } from "@/lib/contracts/auth";
import AuthGate from "@/components/auth/AuthGate";
import type { Session } from "@/lib/contracts/session";

// Both Labeller pages reuse the EXISTING app shell and the V4 shared block renderer.
import LabellerOverview from "@/components/labeller/LabellerOverview";
import IntegratedLabellerWorkspace from "@/components/labeller/IntegratedLabellerWorkspace";
import "@/components/labeller/labeller-mode.css";

type Project = { id: string; name: string };
type LabellerMember = { userId: string; displayName: string; role: string };

// TypeScript: Map each PageId to its human-readable title.
// Record<PageId, string> requires a string title for every PageId.
const titles: Record<PageId, string> = {
  labeller: "Labeller overview",
  "labeller-workspace": "Workspace",
  overview: "Research overview",
  "task-builder": "Task Builder",
  negation: "Negation QC",
  grounding: "Sound grounding",
  caption: "Audio captioning",
  speech: "Transcript & alignment",
  review: "Review & adjudication",
  assets: "Assets & import",
  settings: "Project configuration",
  team: "Team & assignments",
  progress: "Labeller progress",
  exports: "Research exports",
  guide: "Workspace guide",
};

export default function HomePage() {
  return (
    <AuthGate>
      {(session, logout, refreshSession) => (
        <AuthenticatedWorkspace
          key={session.user.userId}
          session={session}
          logout={logout}
          refreshSession={refreshSession}
        />
      )}
    </AuthGate>
  );
}
function AuthenticatedWorkspace({
  session,
  logout,
  refreshSession,
}: {
  session: Session;
  logout: () => Promise<void>;
  refreshSession:()=>Promise<void>;
}) {
  // Typescript generic syntax. What in <...> is a type argument. In this case, onlu PageId is accepted
  const [page, setPage] = useState<PageId>(
    session.memberships[0]?.role === "admin" ? "overview" : "labeller",
  ); // Using the useState hook to manage the current page state. The initial page is set to "overview".

  // page holds the currently selected page
  // setPage is a function that updates the page state when a new page is selected

  // What is useState<PageId>("overview")? It initializes the state variable page with the value "overview" and specifies that the type of page is PageId. This means that page can only hold values that are valid PageId types.

  const [mobileOpen, setMobileOpen] = useState(false); // Using the useState hook to manage the state of the mobile sidebar. The initial state is set to false, meaning the sidebar is closed by default.

  const [role, setRole] = useState<UserRole>(
    session.memberships[0]?.role ?? "labeller",
  );

  // Only projects granted to the verified account are listed; project changes
  // derive the active role from session membership, never a client role toggle.
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const currentMember = {
    userId: session.user.userId,
    projectId,
    displayName: session.user.displayName,
    role,
  };
  const [assignmentDatasetId,setAssignmentDatasetId]=useState("");
  const [labellers, setLabellers] = useState<LabellerMember[]>([]);
  const [membersRevision, setMembersRevision] = useState(0);
  const [labellerId, setLabellerId] = useState(session.user.userId);
  const [catalogError, setCatalogError] = useState("");
  const [focusAssignmentId, setFocusAssignmentId] = useState<string | null>(
    null,
  );
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const currentLabeller = labellers.find(
    (person) => person.userId === labellerId,
  );

  // Fetch PROJECT METADATA only; this does not download audio from R2.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/projects", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Projects HTTP ${response.status}`);
        return response.json() as Promise<{ projects: Project[] }>;
      })
      .then(({ projects: items }) => {
        if (controller.signal.aborted) return;
        const rows = items ?? [];
        setProjects(rows);
        setProjectId((current) =>
          rows.some((item) => item.id === current)
            ? current
            : ((
                rows.find((item) =>
                  item.name.toLowerCase().includes("negation"),
                ) ?? rows[0]
              )?.id ?? ""),
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCatalogError(String(error));
      });
    return () => controller.abort();
  }, []);

  // Fetch only members in the selected project, not a full global account list.
  useEffect(() => {
    const controller = new AbortController();
    setLabellers([]);
    setLabellerId(session.user.userId);
    if (!projectId) return () => controller.abort();
    fetch(
      `/api/v1/project-members?projectId=${encodeURIComponent(projectId)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`Members HTTP ${response.status}`);
        return response.json() as Promise<{ members: LabellerMember[] }>;
      })
      .then(({ members: items }) => {
        if (controller.signal.aborted) return;
        const rows = (items ?? []).filter((item) => item.role === "labeller");
        setLabellers(rows);
        setLabellerId((current) =>
          rows.some((item) => item.userId === current)
            ? current
            : session.user.userId,
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCatalogError(String(error));
      });
    return () => controller.abort();
  }, [projectId, membersRevision, session.user.userId]);
  const activeProjectRole=session.memberships.find(member=>member.projectId===projectId)?.role;
  useEffect(() => {
    const member = session.memberships.find((m) => m.projectId === projectId);
    if (member) {
      setRole(member.role);
      // Preserve the destination chosen on Overview when changing project.
      // Only redirect if the new verified role cannot access the current page.
      setPage(current=>member.role==="admin"?(["labeller","labeller-workspace"].includes(current)?"overview":current):(["labeller","labeller-workspace"].includes(current)?current:"labeller"));
    }
    setLabellerId(session.user.userId);
  }, [projectId, activeProjectRole, session.user.userId]);

  const [builderDirty, setBuilderDirty] = useState(false);
  function canLeaveBuilder() {
    return (
      page !== "task-builder" ||
      !builderDirty ||
      window.confirm("Leave Task Builder and discard unsaved edits?")
    );
  }

  // A pending Labeller autosave is just as important as unsaved Builder edits.
  function canLeaveWorkspace() {
    return (
      page !== "labeller-workspace" ||
      !workspaceDirty ||
      window.confirm(
        "Your annotation has unsaved changes or a pending save. Leave this page?",
      )
    );
  }

  function canLeaveCurrentPage() {
    return canLeaveBuilder() && canLeaveWorkspace();
  }

  function navigate(nextPage: PageId) {
    if (nextPage !== page && !canLeaveCurrentPage()) return;
    if (nextPage !== page) setBuilderDirty(false);
    setPage(nextPage); // Update the page state to the newly selected page
    setMobileOpen(false); // Close the mobile sidebar when a new page is selected
  }

  function changeRole(nextRole: UserRole) {
    if (nextRole === role || !canLeaveCurrentPage()) return;
    setBuilderDirty(false);
    setRole(nextRole); // Update the role state to the newly selected role
    // Update the page state based on the new role. If the new role is "admin", set the page to "overview"; otherwise, set it to "labeller".
    setPage(nextRole === "admin" ? "overview" : "labeller");

    setMobileOpen(false); // Close the mobile sidebar when the role is changed
  }

  // Open a recently annotated assignment from the Labeller Overview.
  function openAssignment(assignmentId: string) {
    setFocusAssignmentId(assignmentId);
    navigate("labeller-workspace");
  }

  function changeProject(nextProjectId: string) {
    if (nextProjectId === projectId || !canLeaveCurrentPage()) return;
    setWorkspaceDirty(false);
    setAssignmentDatasetId("");
    setProjectId(nextProjectId);
    setFocusAssignmentId(null);
  }

  return (
    <div className="al-app">
      {/* Render the Sidebar component with the necessary props */}
      <Sidebar
        member={currentMember}
        activePage={page}
        onNavigate={navigate}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        projects={projects}
        projectId={projectId}
        onProjectChange={changeProject}
        identityRole={activeProjectRole ?? null}
      />{" "}
      {/* Render the Sidebar component with the necessary props */}
      {/* What is onClose defined in SidebarProps? It is a function that is called when the mobile sidebar is closed. In this case, it sets the mobileOpen state to false. */}
      <main className="al-main">
        {/* Top navigation bar */}
        <header className="al-topbar">
          {/* Broadcrumb show the current page in the navigation hierarchy */}
          {/* Mobile menu button */}
          <div className="al-breadcrumb">
            <button
              type="button"
              className="all-menu-button"
              aria-label="Open navigation"
              aria-controls="audiolab-navigation"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              {/* onClick !mobileOpen => open/close the sidebar (Opposite of current state) */}
              <Menu size={19} />{" "}
              {/* Render the Menu icon from lucide-react with a size of 19 */}
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />{" "}
            {/* Render the ChevronRight icon from lucide-react with a size of 19 */}
            <strong>{titles[page]}</strong>
          </div>
          <div className="al-role-preview">
            <span>
              {session.user.displayName} ·{" "}
              {activeProjectRole ?? "No active project role"}
            </span>
            <button
              onClick={() => {
                if (canLeaveCurrentPage()) void logout();
              }}
            >
              Sign out
            </button>
          </div>
        </header>

        {/* Current Page content */}
        <div className="al-content">
          {/* Page heading */}
          {/* Labeller components supply their own headings, so do not duplicate them here. */}
          {role === "admin" && page !== "task-builder" && (
            <div className="al-page-heading">
              <span className="al-eyebrow">AUDIO NEGATION STUDY</span>

              <h1>{titles[page]}</h1>

              <p>From audio candidtaes to auditable human evidence</p>
            </div>
          )}

          {/* The Labeller role uses these two pages; Admin pages below are unchanged. */}
          {catalogError && (
            <p className="alw3-error" role="alert">
              {catalogError}
            </p>
          )}
          {role === "labeller" ? (
            !projectId || !labellerId ? (
              <section className="al-panel">
                <h2>Labeller identity not ready</h2>
                <p>
                  {!projectId
                    ? "Create or select a research project."
                    : "Create a Labeller member in this project to use the local workspace."}
                </p>
              </section>
            ) : page === "labeller" ? (
              <LabellerOverview
                key={`${projectId}:${labellerId}`}
                projectId={projectId}
                labellerId={labellerId}
                labellerName={currentLabeller?.displayName ?? labellerId}
                onOpenWorkspace={() => navigate("labeller-workspace")}
                onOpenAssignment={openAssignment}
              />
            ) : (
              <IntegratedLabellerWorkspace
                key={`${projectId}:${labellerId}:${focusAssignmentId ?? ""}`}
                projectId={projectId}
                labellerId={labellerId}
                focusAssignmentId={focusAssignmentId}
                onDirtyChange={setWorkspaceDirty}
              />
            )
          ) : (
            <>
              {/* Conditional rendering: Research overview */}
              {/* Overview uses authorized aggregate counts; working pages retain their existing workspace components. */}
              {page === "overview" ? (
                <ResearchOverview projectId={projectId} onOpen={(nextProject,page)=>{
                  if(!canLeaveCurrentPage())return;
                  setProjectId(nextProject);setAssignmentDatasetId("");setFocusAssignmentId(null);setPage(page);
                }}/>
              ) : page === "task-builder" && role === "admin" ? (
                <TaskBuilder onDirty={setBuilderDirty} />
              ) : page === "settings" ? (
                <ProjectConfiguration projectId={projectId}
                  projects={projects.filter(project=>session.memberships.some(member=>member.projectId===project.id&&member.role==="admin"))}
                  onSaved={async()=>{
                    // Refresh verified memberships as well as the sidebar list;
                    // a newly created project must not rely on an old role toggle.
                    await refreshSession();
                    const response=await fetch("/api/v1/projects",{cache:"no-store"});
                    if(!response.ok)throw new Error(`Projects HTTP ${response.status}`);
                    const result=await response.json() as {projects:Project[]};setProjects(result.projects);
                  }}/>
              ) : page === "exports" ? (
                <ResearchExportWorkspace key={projectId} projectId={projectId} projectName={projects.find(project=>project.id===projectId)?.name} />
              ) : page === "team" || page === "progress" ? (
                <AdminWorkspace
                  key={`${projectId}:${page}`}
                  projectId={projectId}
                  projects={projects.filter(project=>session.memberships.some(member=>member.projectId===project.id && member.role==="admin"))}
                  initialDatasetId={assignmentDatasetId}
                  onChooseDataset={(nextProject,dataset)=>{if(!canLeaveCurrentPage())return;setProjectId(nextProject);setAssignmentDatasetId(dataset);setFocusAssignmentId(null);}}
                  draftOwnerId={session.user.userId}
                  progress={page === "progress"}
                  onMembersChanged={() =>
                    setMembersRevision((value) => value + 1)
                  }
                />
              ) : (
                // In case page is not "overview", render a message indicating that the workspace has not been implemented yet.
                // JSX: Render this section for unfinished workspaces.
                <section className="al-panel">
                  <h2>{titles[page]}</h2>

                  <p>This workspace has not been implemented yet.</p>
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
