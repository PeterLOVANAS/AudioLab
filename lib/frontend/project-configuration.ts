import type { TaskDraft } from "@/lib/backend/validation/task-definitions";
/** Create a valid editable starter protocol for the teammate's setup form.
 * This creates a new draft, not a published version; richer blocks and future
 * version publication remain owned by Task Builder. Never embeds audio/user IDs.
 */
export function starterTaskDefinition(
  name: string,
  instructions: string,
  blockId = crypto.randomUUID(),
): TaskDraft {
  return {
    name: name.trim(),
    description: "",
    domain: "general",
    instructions:
      instructions.trim() || "Annotate the recording according to this task.",
    policy: {
      requiredIndependentVotes: 1,
      blindToOthers: true,
      requiresReview: false,
    },
    blocks: [
      {
        id: blockId,
        type: "text",
        label: "Annotation",
        required: false,
        multiline: true,
      },
    ],
  };
}
