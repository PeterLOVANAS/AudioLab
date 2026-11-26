/**
 * HTTP request validators (Zod).
 *
 * TypeScript types disappear at runtime: a caller can still send bad JSON.
 * z.strictObject rejects unexpected properties, catching common typos.
 * z.infer creates corresponding TypeScript types from a single schema.
 */
import { z } from "zod";

// Existing account IDs can be non-UUID legacy identities. The API proxy verifies
// actor assertions against the authenticated account; syntax is not authority.
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
  // Backward-compatible actor assertion; proxy.ts requires the verified owner.
  labellerId: userId,
});

export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type StartAssignmentInput = z.infer<typeof startAssignmentSchema>;
