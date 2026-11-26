import { z } from "zod";
/** Browser-only configuration draft. This is never a confirmed allocation or
 * server authority; preview/launch must revalidate every persisted identity.
 * Keys include the verified account and project so different logins stay separate.
 */
export const teamJobDraftSchema = z.object({
  name:z.string().max(120),teamId:z.string(),teamName:z.string().max(120),
  workers:z.array(z.string()).max(20),datasetId:z.string(),protocol:z.string(),
  useEntireDataset:z.boolean().optional(),
  mode:z.enum(["individual","voting"]),seed:z.string(),sampleCount:z.number().int().min(0).max(50),
  keys:z.array(z.string()).max(50),
});
export type TeamJobDraft = z.infer<typeof teamJobDraftSchema>;
const key = (owner:string,project:string) => `audiolab.team-job-draft.v1:${encodeURIComponent(owner)}:${encodeURIComponent(project)}`;
/** Returns null for missing drafts; corrupt/obsolete content throws visibly. */
export function readTeamJobDraft(storage:Pick<Storage,"getItem">,owner:string,project:string):TeamJobDraft|null {
  const raw=storage.getItem(key(owner,project));
  return raw===null?null:teamJobDraftSchema.parse(JSON.parse(raw));
}
/** Persists IDs/configuration only; never stores credentials or worker answers. */
export function saveTeamJobDraft(storage:Pick<Storage,"setItem">,owner:string,project:string,draft:TeamJobDraft) {
  storage.setItem(key(owner,project),JSON.stringify(teamJobDraftSchema.parse(draft)));
}
