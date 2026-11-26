export type Session = {
  user: { userId: string; displayName: string; mode: "demo" | "access" };
  memberships: Array<{
    projectId: string;
    projectName: string;
    displayName: string;
    role: "admin" | "labeller";
  }>;
};
