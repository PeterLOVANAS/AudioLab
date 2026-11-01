import {
  AudioLines,
  BookOpen,
  Database,
  Download,
  FileText,
  Headphones,
  Layers,
  LayoutDashboard,
  Mic2,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";

import type { LucideIcon } from "lucide-react" ; 

import type { ProjectMember, UserRole } from "@/lib/contracts/auth";

export type PageId = 
  | "labeller"
  | "overview"
  | "negation"
  | "grounding"
  | "caption"
  | "speech" 
  | "assets"
  | "settings"
  | "team"
  | "progress"
  | "exports"
  | "review"
  | "guide"; 
  // Union type for all the possible page IDs in the sidebar. PageId can be one of these 


type NavigationItem = { 
    id: PageId; 
    label: string; 
    icon: LucideIcon;
}; // what is LucideIcon? It is a type that represents an icon from the lucide-react library.

type NavigationGroup = {
    heading?: string; // Why use ? The question mark indicates that the heading property is optional. It may or may not be present in a NavigationGroup object.
    items: NavigationItem[]; // an array of NavigationItem objects that belong to this group
}

// heading seperate sections of the sidebar, items are the individual links within each section
const groups: NavigationGroup[] = [
    {
      items: [
        {id: "labeller", label: "Labeller mode", icon: Headphones}, 
        {id: "overview", label: "Research Overview", icon: LayoutDashboard},
      ]
    }, 

    {
      heading: "SOUND ANNOTATION",
      items: [
        {id: "negation", label: "Negation QC", icon: ScanLine}, 
        {id: "grounding", label: "Sound Grounding", icon: Layers},
        {id: "caption", label: "Audio Captioning", icon: FileText},
      ]

    }, 

    {
      heading: "SPEECH ANNOTATION", 
      items: [
        {id: "speech", label: "Transcription & alignment", icon: Mic2},
      ]
    }, 

    {
      heading: "RESEARCH OPERATIONS", 
      items: [
        { id: "review", label: "Review & adjudication", icon: ShieldCheck },
        { id: "assets", label: "Assets & import", icon: Database },
        { id: "settings", label: "Project configuration", icon: SlidersHorizontal },
        { id: "team", label: "Team & assignments", icon: Users },
        { id: "progress", label: "Labeller progress", icon: LayoutDashboard },
        { id: "exports", label: "Research exports", icon: Download },
        { id: "guide", label: "Workspace guide", icon: BookOpen },
      ]
    }
]  // NOTE: id will be fine if it's in union type of PageId, but if it's not, it will throw an error. This is a type safety feature of TypeScript.

type SidebarProps = {
    member: ProjectMember; // the current user, which will be displayed in the sidebar
    activePage: PageId; // the currently active page, which will be highlighted in the sidebar
    onNavigate: (page: PageId) => void; // a callback function that will be called when the user clicks on a navigation item. It takes a PageId as an argument and returns void (nothing)
    mobileOpen: boolean; // whether the sidebar is open on mobile devices
    onClose: () => void; // a callback function that will be called when the user clicks on the close button on mobile devices. It takes no arguments and returns void (nothing)
}
// Props are inputs supplied by parent component to child component. In this case, Sidebar is the child component and App is the parent component. The parent component can pass data to the child component through props. The child component can use the data passed from the parent component to render its UI.
// PageId[] means it could be omit right?: Yes, it can be omitted if the array is not required.
const allowedPagesByRole: Record<UserRole, PageId[]> = {
  admin: [
    "overview",
    "review",
    "assets",
    "settings",
    "team",
    "progress",
    "exports",
    "guide",
  ],

  labeller: [
    "labeller",
    "guide",
  ],
}; 

export default function Sidebar({
  member,
  activePage,
  onNavigate, 
  mobileOpen, 
  onClose, 
}: SidebarProps) {
    // Select the pages permitted for the current role.
    const allowedPages = allowedPagesByRole[member.role];
    const visibleGroups = groups.map((group) => ({
          heading: group.heading, 
          items: group.items.filter((item) => allowedPages.includes(item.id)), // Filter the items in each group based on the allowed pages for the current role. Only include items whose id is in the allowedPages array.
    })).filter((group) => group.items.length > 0 ); 
    return (
        <> {/* React fragment */}
          {/* What is ?: The ? is a conditional operator in React. It means that the content inside the curly braces will only be rendered if the condition is true. In this case, it will only render the <aside> element if mobileOpen is true. */}
          <aside id = "audiolab-navigation" className = {`al-sidebar ${mobileOpen ? "open" : ""}`}>   {/* If mobileOpen is true, use "open" but if not then return empty*/}
          {/* The sidebar on desktop is independent of value from mobileOpen */}
          {/* What is aside? The aside element is used to represent a section of the page that is tangentially related to the main content. It is often used for sidebars or additional information. */}

            <button className = "al-brand" onClick = {() => onNavigate(member.role === "admin" ? "overview" : "labeller")}> {/* The => delays execution until the button is clicked */ }
              {/* If member.role = admin, it then display overview page.  If not, display labeller page. */}
              <span className = "al-brand-icon">
                <AudioLines size = {25} /> {/* Render icon AudioLine from Lucide, 25 is normal size */}
              </span>

              <span>
                AudioLab
                <small>RESEARCH WORKSPACE</small>
              </span>
            </button>
            <div className="al-project">
              <label htmlFor="project-select">Project</label> {/* The label is associated with the select element by the htmlFor attribute */}


              <select id = "project-select" defaultValue = "negation-study">
                <option value = "negation-study"> Audio negation study </option>
              </select>

              <small>Research collection · Demo</small> {/* The small element is used to display a smaller text, typically for additional information or disclaimers. */}
            </div>

            
            {/* Navigation: Render navigation groups and their items */}
            <nav className="al-navigation" aria-label="Main navigation">

              {/* We transform group objects into JSX elements using .map() */}
              {visibleGroups.map((group, index) => {

                // key is a special React attribute used to identify
                // elements in a list.

                // ?? means that if group.heading is null or undefined,
                // the resulting React key will be group-index.
                // For example: group-0, group-1, etc.
                const groupKey = group.heading ?? `group-${index}`;

                return (
                  <div key={groupKey}>

                    {/* JS trick: The && operator is used to conditionally
                        render an element only if the condition is truthy.
                        Example: If group.heading exists and is not empty,
                        render the heading <div>. */}
                    {group.heading && (
                      <div className="al-nav-label">
                        {group.heading}
                      </div>
                    )}

                    {/* Loop through the items inside the current group | items is list */}
                    {group.items.map((item) => {

                      // Get the icon component associated with this item.
                      // Use uppercase Icon because JSX interprets
                      // uppercase names as React components.
                      const Icon = item.icon;

                      // If activePage is equal to item.id,
                      // add "active" to the className.
                      const isActive = activePage === item.id;

                      return (
                        <button
                          type="button"
                          key={item.id}
                          className={
                            isActive ? "al-nav-item active" : "al-nav-item"
                          } /* if isActive=true, then className="al-nav-item active" otherwise className="al-nav-item" */
                          aria-current={
                            isActive ? "page" : undefined
                          }
                          onClick={() => onNavigate(item.id)}
                        >
                          {/* Display the icon of the navigation item */}
                          <Icon size={18} />

                          {/* Display the label of the navigation item */}
                          <span>{item.label}</span>
                        </button>
                      );

                    })}

                  </div>
                );

              })}

            </nav>
            
            {/* Account and application footer */}
            <div className = "al-sidebar-footer">
              
              {/* Account information */}
              <div className = "al-user">

                <span className = "al-avatar">AL</span>

                {/* Display the user's name and role */}
                <div>
                  <strong>Demo researcher</strong>
                  <small>Local preview</small>
                </div>
              </div>

              {/* Display the application information */}
              <p>AudioLab 2.0 · Development</p>

            </div>

          </aside>
          
          {/* Logic: If mobileOpen is true, render the backdrop button */}
          {mobileOpen && (
            <button className="al-sidebar-backdrop" aria-label="Close navigation" onClick={onClose}></button>
          )}


          
        </>
    )
}


