/**
 * HTTP request validators (Zod).
 *
 * TypeScript types disappear at runtime: a caller can still send bad JSON.
 * z.strictObject rejects unexpected properties, catching common typos.
 * z.infer creates corresponding TypeScript types from a single schema.
 */
import { z } from "zod";

// For now, identity is a local demo string, e.g. "test-labeller-123".
// A future auth provider might supply non-UUID IDs, so don't require UUIDs.
const userId = z.string().trim().min(1).max(128);

export const createMemberSchema = z.strictObject({
  projectId: z.uuid(),
  userId,
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(["admin", "labeller"]),
});

export const createAssignmentSchema = z.strictObject({
  projectId: z.uuid(),
  taskInstanceId: z.uuid(),
  labellerId: userId,
});

export const startAssignmentSchema = z.strictObject({
  // DEV ONLY: caller supplies this user ID. With authentication, the backend
  // will derive it from a trusted session and remove it from request JSON.
  labellerId: userId,
});

export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type StartAssignmentInput = z.infer<typeof startAssignmentSchema>;
