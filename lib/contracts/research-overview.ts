/** Cross-project annotation operations, not worker performance or accepted review
 * outputs. Item completion requires every active assignment for that source item.
 */
export type ResearchProjectStats = {
  id: string;
  name: string;
  slug: string;
  datasets: number;
  audioFiles: number;
  definitions: number;
  labellers: number;
  jobs: number;
  completedJobs: number;
  assignments: number;
  submitted: number;
  inProgress: number;
  pending: number;
  sourceItems: number;
  completedSourceItems: number;
  lastSubmittedAt: string | null;
  status: "setup" | "active" | "complete";
};
export type ResearchOverview = {
  asOf: string;
  scope: "admin-projects";
  projects: ResearchProjectStats[];
  totals: {
    projects: number;
    datasets: number;
    audioFiles: number;
    jobs: number;
    assignments: number;
    submitted: number;
    sourceItems: number;
    completedSourceItems: number;
  };
};
