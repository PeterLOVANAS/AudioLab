import type { ProjectMember, UserRole } from "@/lib/contracts/auth";

// Record is a TypeScript utility type that describe object whose keys come from UserRole and values conform to ProjectMember (In-order)
// We could demoMembers.admin to get the admin user, and demoMembers.labeller to get the labeller user.
export const demoMembers: Record<UserRole, ProjectMember> = {
      admin: {
        userId: "admin-001",
        projectId: "negation-study",
        displayName: "Admin User",
        role: "admin"
      },
      labeller: {
        userId: "labeller-001",
        projectId: "negation-study",
        displayName: "Labeller User",
        role: "labeller"
      }
}