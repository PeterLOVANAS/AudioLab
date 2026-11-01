/**
 * Runtime validator for the HTTP request SHAPE.
 *
 * We validate the meaning of each answer in validateAnswers() (service side),
 * because the right answer format depends on a *published* task definition
 * loaded from D1, not a schema the client can be trusted to supply.
 */
import { z } from "zod";

export const annotationWriteSchema = z.strictObject({
  // Lesson 8 dev identity, not a verified login. Production must use session.
  labellerId: z.string().trim().min(1).max(128),
  // Client supplies the revision it last loaded, not the NEW revision.
  // Revision 0 means this assignment has never had a saved annotation.
  expectedRevision: z.number().int().min(0),
  // Values: string | string[] | number | boolean | ... depending on block.
  // JSON parsing has already limited the values to JSON-compatible types.
  answers: z.record(z.string(), z.unknown()),
});
export type AnnotationWriteInput = z.infer<typeof annotationWriteSchema>;
