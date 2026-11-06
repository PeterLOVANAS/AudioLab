/**
 * AudioLab Task Definitions — REQUEST VALIDATION LAYER
 * ----------------------------------------------------
 * Purpose: turn untrusted JSON from an HTTP request into checked data.
 *
 * A TypeScript type is erased when code runs. For example, declaring a field as
 * `string` does not stop a browser from sending 42 in JSON. Zod performs
 * checks at runtime BEFORE our service or database receives that input.
 *
 * Route -> Zod schema -> service -> repository -> D1
 *
 * This first version validates the common fields for all 13 block types.
 * It is NOT yet a complete semantic validator for every advanced block.
 */
import { z } from "zod";

/**
 * A closed list of allowed block kinds. Anything else receives HTTP 400.
 * `z.enum` checks a string against these options at runtime; its union of
 * literal strings is also available to TypeScript through `z.infer`.
 */
const blockTypeSchema = z.enum([
  "single_choice",
  "multiple_choice",
  "boolean",
  "number",
  "rating_scale",
  "text",
  "transcript",
  "timeline_annotation",
  "continuous_rating",
  "candidate_vote",
  "audio_comparison",
  "ranking",
  "repeated_group",
  // Purely presentational blocks: their IDs never occur in human answers.
  "section", "callout", "audio_player", "transcript_summary",
]);

/**
 * Fields shared by all block types.
 *
 * `.trim()` strips surrounding whitespace from strings.
 * `.min(1)` rejects an empty label or ID after trimming.
 * `.passthrough()` deliberately RETAINS additional per-block fields such as
 *   `options`, `showWhen`, transcript formats, and timeline tiers.
 *
 * Why not `.strictObject()` for blocks? Your existing TaskDefinition union
 * has different settings for each block type. We don't want to silently
 * strip those settings while saving drafts. But passthrough means unknown
 * fields also pass: full discriminated-union validation is still required
 * before using advanced blocks in production annotations.
 */
const blockSchema = z.object({
  id: z.string().trim().min(1).max(80),
  type: blockTypeSchema,
  label: z.string().trim().min(1).max(300),
  required: z.boolean(),
}).passthrough();

/**
 * Annotation policy is part of the definition, NOT a vote or annotation yet.
 * 2 independent votes means the future assignment engine must collect at
 * least two independent submissions for a task instance.
 *
 * `.strictObject()` rejects unexpected keys, helping catch typos in policy
 * field names when the Task Builder frontend sends its JSON payload.
 */
const policySchema = z.strictObject({
  requiredIndependentVotes: z.number().int().min(1).max(20),
  blindToOthers: z.boolean(),
  requiresReview: z.boolean(),
});

/**
 * Which audio tools should the future Labeller workspace offer?
 * All properties are optional booleans; no visualization is computed here.
 * For example, `spectrogram: true` is a UI configuration request, not an
 * instruction to the backend to generate spectrogram pixels.
 */
const workspaceSchema = z.object({
  waveform: z.boolean().optional(),
  spectrogram: z.boolean().optional(),
  pitch: z.boolean().optional(),
  formants: z.boolean().optional(),
  mfcc: z.boolean().optional(),
  allowTextGridImport: z.boolean().optional(),
}).passthrough();

/**
 * A DRAFT is the editable description of one annotation protocol.
 * It does not include the recording/asset ID: task instances will later link
 * one published definition version to one or more recordings.
 *
 * `.superRefine()` runs extra checks that depend on MULTIPLE blocks. Simple
 * per-field validation above cannot detect duplicate IDs or references to
 * blocks that appear later in the form.
 */
export const taskDraftSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000),
  domain: z.enum(["sound", "speech", "general"]),
  instructions: z.string().trim().min(1).max(20000),
  blocks: z.array(blockSchema).min(1).max(100),
  policy: policySchema,
  workspace: workspaceSchema.optional(),
}).superRefine((definition, ctx) => {
  // `seen` contains IDs of PREVIOUS blocks as we iterate left-to-right.
  // It serves two roles: detecting duplicate block IDs and checking that
  // a conditional block only references a question already encountered.
  const seen = new Set<string>();

  for (let index = 0; index < definition.blocks.length; index++) {
    const block = definition.blocks[index];

    // Two answers must not share the same block ID. Otherwise the future
    // annotation payload would not be able to identify its intended block.
    if (seen.has(block.id)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate block id: ${block.id}`,
        // Zod attaches this error directly to blocks[index].id, so a form
        // builder can highlight the specific offending input.
        path: ["blocks", index, "id"],
      });
    }

    // `showWhen` is an optional rule, e.g.:
    // { blockId: "audible", equals: "yes" }
    // If a block depends on a later block, the form could become cyclic.
    // We therefore require it to refer to a PREVIOUS block in `seen`.
    const condition = block.showWhen;
    if (condition !== undefined) {
      if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
        ctx.addIssue({
          code: "custom",
          message: "showWhen must be an object",
          path: ["blocks", index, "showWhen"],
        });
      } else {
        const c = condition as Record<string, unknown>;
        if (typeof c.blockId !== "string" || !seen.has(c.blockId) || !("equals" in c)) {
          ctx.addIssue({
            code: "custom",
            message: "showWhen must reference an earlier block and include equals",
            path: ["blocks", index, "showWhen"],
          });
        }
      }
    }

    // A choice question needs at least two answer options.
    // `passthrough` lets `block.options` exist, but it does not validate it:
    // these extra checks enforce basic option shape and uniqueness.
    if (block.type === "single_choice" || block.type === "multiple_choice") {
      const options = block.options;
      if (!Array.isArray(options) || options.length < 2) {
        ctx.addIssue({
          code: "custom",
          message: "Choice blocks need at least two options",
          path: ["blocks", index, "options"],
        });
      } else {
        const ids = new Set<string>();
        for (let j = 0; j < options.length; j++) {
          const option = options[j];
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            ctx.addIssue({
              code: "custom",
              message: "Option must be an object",
              path: ["blocks", index, "options", j],
            });
            continue; // Skip property checks when this option isn't an object.
          }

          const o = option as Record<string, unknown>;
          if (
            typeof o.id !== "string" || !o.id.trim() ||
            typeof o.label !== "string" || !o.label.trim() ||
            ids.has(o.id)
          ) {
            ctx.addIssue({
              code: "custom",
              message: "Each option needs a unique id and nonempty label",
              path: ["blocks", index, "options", j],
            });
          }
          if (typeof o.id === "string") ids.add(o.id);
        }
      }
    }

    /**
     * A display-only block has no answer. `required=true` would falsely imply
     * that the server expects a key in annotation_revisions.answers.
     */
    if (["section", "callout", "audio_player", "transcript_summary"].includes(block.type)) {
      if (block.required) ctx.addIssue({
        code: "custom", path: ["blocks", index, "required"],
        message: "Display-only blocks must have required=false",
      });
      if ((block.type === "section" || block.type === "callout") &&
          block.tone !== undefined &&
          !["neutral", "success", "warning", "info"].includes(String(block.tone)))
        ctx.addIssue({ code: "custom", path: ["blocks", index, "tone"], message: "Invalid display tone" });
      if (block.description !== undefined &&
          (typeof block.description !== "string" || block.description.length > 10000))
        ctx.addIssue({ code: "custom", path: ["blocks", index, "description"],
          message: "Display description must be text, max 10,000 characters" });
    }
    if (block.type === "transcript_summary") {
      const source = definition.blocks.slice(0, index).find(
        b => b.id === block.sourceTimelineBlockId && b.type === "timeline_annotation");
      if (!source) ctx.addIssue({ code:"custom", path:["blocks",index,"sourceTimelineBlockId"],
        message:"Summary must reference an earlier Timeline Grounding block" });
      if (block.summaryMode !== undefined &&
          !["words", "phones", "both"].includes(String(block.summaryMode)))
        ctx.addIssue({ code:"custom", path:["blocks",index,"summaryMode"],
          message:"Invalid summary mode" });
    }
    /**
     * Timeline data needs a reliable schema even before a single segment
     * exists. We check the tier topology here and *answers* separately on
     * submission. A parent means semantic association, not forced timing.
     */
    if (block.type === "timeline_annotation") {
      const tiers = block.tiers;
      if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 10) {
        ctx.addIssue({ code: "custom", path: ["blocks", index, "tiers"],
          message: "Timeline needs between 1 and 10 tiers" });
      } else {
        const tierIds = new Set<string>();
        tiers.forEach((tier, j) => {
          if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
            ctx.addIssue({ code: "custom", path: ["blocks", index, "tiers", j],
              message: "Tier must be an object" });
            return;
          }
          const t = tier as Record<string, unknown>;
          if (typeof t.id !== "string" || !t.id.trim() || tierIds.has(t.id) ||
              typeof t.name !== "string" || !t.name.trim() || t.kind !== "interval")
            ctx.addIssue({ code: "custom", path: ["blocks", index, "tiers", j],
              message: "Each tier requires a unique ID, a name, and interval kind" });
          if (typeof t.id === "string") tierIds.add(t.id);
          if (typeof t.allowOverlap !== "boolean")
            ctx.addIssue({ code: "custom", path: ["blocks", index, "tiers", j, "allowOverlap"],
              message: "Tier allowOverlap must be a boolean" });
          if (!["text", "choice", "ipa", "speaker_id"].includes(String(t.labelMode)))
            ctx.addIssue({ code: "custom", path: ["blocks", index, "tiers", j, "labelMode"],
              message: "Invalid tier label mode" });
        });
        tiers.forEach((tier, j) => {
          if (tier && typeof tier === "object" && !Array.isArray(tier)) {
            const t = tier as Record<string, unknown>;
            if (t.parentTierId !== undefined &&
                (typeof t.parentTierId !== "string" || !tierIds.has(t.parentTierId) || t.id === t.parentTierId))
              ctx.addIssue({ code: "custom", path: ["blocks", index, "tiers", j, "parentTierId"],
                message: "Parent tier must be another tier in this block" });
          }
        });
      }
    }

    // Add the current block only AFTER checking its conditional reference.
    // This makes self-references invalid, as intended.
    seen.add(block.id);
  }
});

/**
 * `z.infer` produces a TypeScript type from the runtime validator, keeping
 * this backend's draft data and its validation rules aligned.
 *
 * This is the persisted DRAFT shape, not the published TaskDefinition type
 * from `lib/contracts/tasks.ts` (which also contains an ID and a version).
 */
export type TaskDraft = z.infer<typeof taskDraftSchema>;

// POST /task-definitions: associate a new draft with an EXISTING project.
export const createTaskDefinitionSchema = z.strictObject({
  projectId: z.uuid(),
  draft: taskDraftSchema,
});

// PUT /task-definitions/:id: require the revision the editor last read.
// A stale expectedRevision prevents accidental overwrites between editors.
export const updateTaskDefinitionSchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  draft: taskDraftSchema,
});

// POST /task-definitions/:id/publish: two counters protect the operation:
// (a) exact draft revision and (b) current published version.
// Both must still match the server's values when publication runs.
export const publishTaskDefinitionSchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  expectedPublishedVersion: z.number().int().min(0),
});
