"use client"; // This directive indicates that the file is a client-side component in Next.js, meaning it will be rendered on the client side rather than the server side. It allows the use of React hooks and other client-side features.

import { useState } from "react"; // Importing the useState hook from React, which allows us to manage state in functional components.

import  {
  Menu, 
  ChevronRight, 
  Database,
  CheckCircle2, 
  ShieldCheck, 
  Headphones
} from "lucide-react"; // Importing specific icons from the lucide-react library, which provides a collection of SVG icons for React applications.

import Sidebar , {
  type PageId
} from "@/components/layout/Sidebar"; // Importing the Sidebar component and the PageId type from a local file. The Sidebar component is likely a custom component for navigation, and PageId is a type definition for page identifiers.
 

import StatCard from "@/components/overview/StatCard"; // Importing the StatCard component from a local file. This component is likely used to display statistical information in a card format.


import TaskBuilder from "@/components/task-builder/TaskBuilder";
import type { UserRole } from "@/lib/contracts/auth";
import { demoMembers } from "@/fixtures/users";


// TypeScript: Map each PageId to its human-readable title.
// Record<PageId, string> requires a string title for every PageId.
const titles: Record<PageId, string> = {
  labeller: "Labeller Mode",
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
} ; 


export default function HomePage() {
    // Typescript generic syntax. What in <...> is a type argument. In this case, onlu PageId is accepted
    const [page, setPage] = useState<PageId>("overview"); // Using the useState hook to manage the current page state. The initial page is set to "overview".

    // page holds the currently selected page
    // setPage is a function that updates the page state when a new page is selected

    // What is useState<PageId>("overview")? It initializes the state variable page with the value "overview" and specifies that the type of page is PageId. This means that page can only hold values that are valid PageId types.

    const [mobileOpen, setMobileOpen] = useState(false); // Using the useState hook to manage the state of the mobile sidebar. The initial state is set to false, meaning the sidebar is closed by default.


    const [role, setRole] = useState<UserRole>("admin");
    const currentMember = demoMembers[role];

    const [builderDirty, setBuilderDirty] = useState(false);
    function canLeaveBuilder() {
        return page !== "task-builder" || !builderDirty || window.confirm("Leave Task Builder and discard unsaved edits?");
    }

    function navigate(nextPage: PageId) {
        if (nextPage !== page && !canLeaveBuilder()) return;
        if (nextPage !== page) setBuilderDirty(false);
        setPage(nextPage); // Update the page state to the newly selected page
        setMobileOpen(false); // Close the mobile sidebar when a new page is selected
    }

    function changeRole(nextRole: UserRole) {
        if (!canLeaveBuilder()) return;
        setBuilderDirty(false);
        setRole(nextRole); // Update the role state to the newly selected role
        // Update the page state based on the new role. If the new role is "admin", set the page to "overview"; otherwise, set it to "labeller".
        setPage(nextRole === "admin" ? "overview" : "labeller");

        setMobileOpen(false); // Close the mobile sidebar when the role is changed
    }



    return (
        <div className = "al-app">
          
          {/* Render the Sidebar component with the necessary props */}
          <Sidebar member={currentMember} activePage = {page} onNavigate = {navigate} mobileOpen = {mobileOpen} onClose = {() => setMobileOpen(false)}/> {/* Render the Sidebar component with the necessary props */}
          {/* What is onClose defined in SidebarProps? It is a function that is called when the mobile sidebar is closed. In this case, it sets the mobileOpen state to false. */}
          
          <main className = "al-main">
            {/* Top navigation bar */}
            <header className = "al-topbar">

              {/* Broadcrumb show the current page in the navigation hierarchy */}
              {/* Mobile menu button */}
              <div className = "al-breadcrumb">
                <button type="button" className="all-menu-button" aria-label="Open navigation" aria-controls="audiolab-navigation" aria-expanded = {mobileOpen} onClick={() => setMobileOpen(!mobileOpen)}>
                  {/* onClick !mobileOpen => open/close the sidebar (Opposite of current state) */}
                  <Menu size = {19}/> {/* Render the Menu icon from lucide-react with a size of 19 */}
                </button>

                <span>Workspace</span>
                <ChevronRight size = {14}/> {/* Render the ChevronRight icon from lucide-react with a size of 19 */}
                <strong>{titles[page]}</strong>
              </div>
              <div className = "al-role-preview">
                <label htmlFor = "demo-role">Demo role</label>
                <select id = "demo-role" value = {role} onChange={(event) => changeRole(event.target.value as UserRole)}>
                  {/* When user select a different option, it create event!!!  We read the value by use event.target.value then pass to changeRole() */}
                  <option value = "admin">Admin</option>
                  <option value = "labeller">Labeller</option>
                </select>
                <span className = "al-status">Local preview</span>
              </div>
            </header>

            {/* Current Page content */}
            <div className = "al-content">
              {/* Page heading */}
              {page !== "task-builder" && <div className = "al-page-heading">
                <span className="al-eyebrow">
                  AUDIO NEGATION STUDY
                </span>

                <h1>{titles[page]}</h1>

                <p>
                  From audio candidtaes to auditable human evidence
                </p>
              </div>}

              {/* Conditional rendering: Research overview */}
              {/* if page = overview, then render the statistics grid. If not, render a message indicating that the workspace has not been implemented yet. */}
              {page === "overview" ? (

                <section className = "al-stat-grid" aria-label="Research overview statistics">
                    <StatCard label ="Annotation tasks" value ={0} note = "No research tasks imported yet" icon = {Database}/> {/* Render a StatCard component with the specified props */}
                    <StatCard label = "Your submissions" value = {0} note = "Completed annotations" icon = {CheckCircle2}/> {/* Render a StatCard component with the specified props */}
                    <StatCard label = "Your drafts" value = {0} note = "Unsubmitted annotations" icon = {ShieldCheck}/> {/* Render a StatCard component with the specified props */}
                    <StatCard label = "Your remaining tasks" value = {0} note = "Tasks awaiting annotation" icon = {Headphones}/> {/* Render a StatCard component with the specified props */}
                
                </section>
              ) : page === "task-builder" && role === "admin" ? (
                  <TaskBuilder onDirty={setBuilderDirty} />
              ) : (
                  // In case page is not "overview", render a message indicating that the workspace has not been implemented yet.
                  // JSX: Render this section for unfinished workspaces.
                  <section className="al-panel">
                    <h2>{titles[page]}</h2>

                    <p>
                      This workspace has not been implemented yet.
                    </p>
                  </section>
              )
              }

            </div>
          </main>
        </div>
    ); 
}
