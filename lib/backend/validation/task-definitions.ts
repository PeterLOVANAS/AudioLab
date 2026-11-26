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
  "section",
  "callout",
  "audio_player",
  "transcript_summary",
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
const missingValuePolicy = z.enum(["block", "empty", "use_default"]);
const datasetTextBinding = z.strictObject({
  kind: z.literal("dataset"),
  fieldId: z
    .string()
    .regex(/^(question|(?:item|sample)\.[a-zA-Z][a-zA-Z0-9_]{0,63})$/),
  type: z.literal("string"),
  missingValuePolicy: missingValuePolicy.optional(),
});
const datasetValueBinding = datasetTextBinding.extend({
  type: z.enum(["string", "textgrid"]),
  mode: z.enum(["reference", "read_only", "prefill"]),
  fallback: z.string().max(20000).optional(),
});

const blockSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    type: blockTypeSchema,
    label: z.string().trim().min(1).max(300),
    required: z.boolean(),
    allowCustom: z.boolean().optional(),
    showSourceAnswer: z.boolean().optional(),
    trainingAnswerPreview: z.boolean().optional(),
    answerAppearance: z
      .enum(["cards", "compact", "bullets", "exam", "checkbox-grid"])
      .optional(),
    sourceBindings: z
      .strictObject({
        preview: z
          .strictObject({
            kind: z.literal("dataset"),
            fieldId: z
              .string()
              .regex(
                /^(reference_answer|(?:item|sample)\.[a-zA-Z][a-zA-Z0-9_]{0,63})$/,
              ),
            type: z.enum([
              "string",
              "number",
              "boolean",
              "choices",
              "textgrid",
              "json",
            ]),
          })
          .optional(),
        label: datasetTextBinding.optional(),
        helpText: datasetTextBinding.optional(),
        options: z
          .strictObject({
            kind: z.literal("dataset"),
            fieldId: z
              .string()
              .regex(/^(choices|(?:item|sample)\.[a-zA-Z][a-zA-Z0-9_]{0,63})$/),
            type: z.enum(["string[]", "choices", "string"]),
            format: z.enum(["array", "json", "lines", "delimiter"]).optional(),
            delimiter: z.string().min(1).max(8).optional(),
            stripPrefix: z.boolean().optional(),
            missingValuePolicy: z.enum(["block", "use_default"]).optional(),
          })
          .optional(),
        value: datasetValueBinding.optional(),
      })
      .optional(),
  })
  .passthrough();

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
const workspaceSchema = z
  .object({
    waveform: z.boolean().optional(),
    spectrogram: z.boolean().optional(),
    pitch: z.boolean().optional(),
    formants: z.boolean().optional(),
    mfcc: z.boolean().optional(),
    allowTextGridImport: z.boolean().optional(),
  })
  .passthrough();

/**
 * A DRAFT is the editable description of one annotation protocol.
 * It does not include the recording/asset ID: task instances will later link
 * one published definition version to one or more recordings.
 *
 * `.superRefine()` runs extra checks that depend on MULTIPLE blocks. Simple
 * per-field validation above cannot detect duplicate IDs or references to
 * blocks that appear later in the form.
 */
export const taskDraftSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4000),
    domain: z.enum(["sound", "speech", "general"]),
    instructions: z.string().trim().min(1).max(20000),
    instructionBinding: datasetTextBinding.optional(),
    blocks: z.array(blockSchema).min(1).max(100),
    policy: policySchema,
    workspace: workspaceSchema.optional(),
  })
  .superRefine((definition, ctx) => {
    // `seen` contains IDs of PREVIOUS blocks as we iterate left-to-right.
    // It serves two roles: detecting duplicate block IDs and checking that
    // a conditional block only references a question already encountered.
    const seen = new Set<string>();
    validateGroups(definition, ctx);

    if (
      definition.blocks.filter(
        (block) =>
          block.type === "candidate_vote" && block.candidateSource === "set",
      ).length > 1
    )
      ctx.addIssue({
        code: "custom",
        path: ["blocks"],
        message:
          "Use one candidate-selection block per voting job; separate ballots need separate jobs",
      });

    for (let index = 0; index < definition.blocks.length; index++) {
      const block = definition.blocks[index];
      if (
        "batchBlocks" in block ||
        "initialValue" in block ||
        "sourceAnswerPreview" in block
      )
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index],
          message:
            "Resolved source values cannot be authored in a Task Definition",
        });
      if (
        block.allowCustom &&
        !["single_choice", "multiple_choice"].includes(block.type)
      )
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index, "allowCustom"],
          message: "Custom answers require a choice block",
        });
      if (
        Array.isArray(block.options) &&
        block.options.some(
          (option) =>
            option &&
            typeof option === "object" &&
            "id" in option &&
            option.id === "__custom__",
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index, "options"],
          message: "__custom__ is reserved for written answers",
        });
      const optionBinding = block.sourceBindings?.options;
      const previewBinding = block.sourceBindings?.preview;
      if (
        previewBinding &&
        ((previewBinding.fieldId === "reference_answer" &&
          (previewBinding.type !== "json" ||
            !block.trainingAnswerPreview ||
            !block.showSourceAnswer ||
            !["single_choice", "multiple_choice"].includes(block.type))) ||
          (previewBinding.fieldId !== "reference_answer" &&
            previewBinding.type === "json"))
      )
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index, "sourceBindings", "preview"],
          message:
            "Private answer preview requires a choice block with explicit training mode and preview enabled.",
        });
      if (
        optionBinding &&
        ((optionBinding.type === "string" &&
          (!optionBinding.format || optionBinding.format === "array")) ||
          (optionBinding.type !== "string" &&
            optionBinding.format &&
            optionBinding.format !== "array") ||
          (optionBinding.format === "delimiter" && !optionBinding.delimiter))
      )
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index, "sourceBindings", "options"],
          message: "Choice format must match its source type and delimiter",
        });
      if (
        block.sourceBindings?.options &&
        !["single_choice", "multiple_choice"].includes(block.type)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Dataset choices require a choice question.",
          path: ["blocks", index, "sourceBindings", "options"],
        });
      }

      // Ordered audio batches resolve one immutable source per panel. Repeated
      // groups still need an explicit item-context contract before source binding.
      if (
        block.sourceBindings &&
        Object.values(block.sourceBindings).some(Boolean)
      ) {
        if (block.type === "repeated_group")
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "sourceBindings"],
            message:
              "Dataset bindings on repeated groups require item-context support",
          });
        const value = block.sourceBindings.value;
        if (value) {
          if (
            (value.type === "textgrid"
              ? block.type !== "timeline_annotation" || value.mode !== "prefill"
              : !["text", "transcript"].includes(block.type)) ||
            (value.mode === "read_only" && block.required)
          )
            ctx.addIssue({
              code: "custom",
              path: ["blocks", index, "sourceBindings", "value"],
              message:
                "Text bindings require text/transcript; TextGrid requires timeline prefill; read-only context cannot require an answer",
            });
          if (value.mode === "prefill" && block.showWhen)
            ctx.addIssue({
              code: "custom",
              path: ["blocks", index, "sourceBindings", "value"],
              message:
                "Conditional prefill is unsupported; use reference context",
            });
          if (
            value.missingValuePolicy === "use_default" &&
            value.fallback === undefined
          )
            ctx.addIssue({
              code: "custom",
              path: ["blocks", index, "sourceBindings", "value"],
              message:
                "A value binding with use_default requires explicit fallback text",
            });
        }
        if (
          block.sourceBindings.options &&
          block.optionFollowUps &&
          typeof block.optionFollowUps === "object" &&
          Object.values(block.optionFollowUps).some(
            (children) => !Array.isArray(children) || children.length > 0,
          )
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "optionFollowUps"],
            message: "Dynamic choices cannot use static option follow-ups",
          });
      }

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
        if (
          !condition ||
          typeof condition !== "object" ||
          Array.isArray(condition)
        ) {
          ctx.addIssue({
            code: "custom",
            message: "showWhen must be an object",
            path: ["blocks", index, "showWhen"],
          });
        } else {
          const c = condition as Record<string, unknown>;
          if (
            typeof c.blockId !== "string" ||
            !seen.has(c.blockId) ||
            !("equals" in c)
          ) {
            ctx.addIssue({
              code: "custom",
              message:
                "showWhen must reference an earlier block and include equals",
              path: ["blocks", index, "showWhen"],
            });
          }
        }
      }

      // Bound choices are validated after authoritative resolution, not placeholders.
      // A choice question needs at least two answer options.
      // `passthrough` lets `block.options` exist, but it does not validate it:
      // these extra checks enforce basic option shape and uniqueness.
      if (
        !block.sourceBindings?.options &&
        (block.type === "single_choice" ||
          block.type === "multiple_choice" ||
          block.type === "audio_comparison" ||
          (block.type === "candidate_vote" && block.options !== undefined))
      ) {
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
            if (
              !option ||
              typeof option !== "object" ||
              Array.isArray(option)
            ) {
              ctx.addIssue({
                code: "custom",
                message: "Option must be an object",
                path: ["blocks", index, "options", j],
              });
              continue; // Skip property checks when this option isn't an object.
            }

            const o = option as Record<string, unknown>;
            if (
              typeof o.id !== "string" ||
              !o.id.trim() ||
              typeof o.label !== "string" ||
              !o.label.trim() ||
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

      /** v4 — batch, ranking and inline choice conditions are part of the frozen
       * Task Definition JSON. These checks intentionally occur at publication
       * and at DRAFT save, not merely in the React preview. */
      const n =
        block.numBatch === undefined
          ? block.type === "audio_comparison"
            ? 2
            : 1
          : block.numBatch;
      if (!Number.isInteger(n) || typeof n !== "number" || n < 1 || n > 24)
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index, "numBatch"],
          message: "NUM_BATCH must be an integer from 1 to 24",
        });
      if (block.type === "audio_comparison") {
        const size =
          block.comparisonSize === undefined ? 2 : block.comparisonSize;
        if (
          typeof size !== "number" ||
          !Number.isInteger(size) ||
          size < 2 ||
          size > 4 ||
          typeof n !== "number" ||
          n < size ||
          n % size !== 0
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "comparisonSize"],
            message:
              "Comparison group size must be 2–4 and divide NUM_BATCH exactly",
          });
        if (
          block.comparisonButtonSize !== undefined &&
          !["sm", "md", "lg"].includes(String(block.comparisonButtonSize))
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "comparisonButtonSize"],
            message: "Invalid button size",
          });
        if (
          block.comparisonButtonPosition !== undefined &&
          !["inside", "outside"].includes(
            String(block.comparisonButtonPosition),
          )
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "comparisonButtonPosition"],
            message: "Invalid button placement",
          });
      }
      if (
        block.type === "rating_scale" &&
        block.ratingAppearance !== undefined &&
        !["buttons", "slider"].includes(String(block.ratingAppearance))
      )
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index, "ratingAppearance"],
          message: "Invalid rating display mode",
        });
      if (block.type === "ranking") {
        if (
          block.rankingMode !== undefined &&
          !["audios", "labels"].includes(String(block.rankingMode))
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "rankingMode"],
            message: "Invalid ranking mode",
          });
        if (
          block.rankingInput !== undefined &&
          !["drag", "arrows", "comma"].includes(String(block.rankingInput))
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "rankingInput"],
            message: "Invalid ranking interaction",
          });
        const list =
          block.rankingMode === "labels"
            ? block.rankLabels
            : block.stimulusSlots;
        // IDs are opaque identities, never derived from display labels. Do not
        // normalize them here: changing spelling would invalidate saved answers.
        const labels = z
          .array(
            z.object({
              id: z
                .string()
                .min(1)
                .max(80)
                .refine((id) => id === id.trim()),
              label: z.string().trim().min(1).max(300),
            }),
          )
          .min(2)
          .max(12)
          .safeParse(list);
        const slots = z
          .array(z.string().trim().min(1).max(300))
          .min(2)
          .max(12)
          .safeParse(list);
        const validItems =
          block.rankingMode === "labels"
            ? labels.success &&
              new Set(labels.data.map((item) => item.id)).size ===
                labels.data.length
            : slots.success && new Set(slots.data).size === slots.data.length;
        if (!validItems)
          ctx.addIssue({
            code: "custom",
            path: [
              "blocks",
              index,
              block.rankingMode === "labels" ? "rankLabels" : "stimulusSlots",
            ],
            message:
              "Ranking needs 2–12 named items with distinct stable IDs (or distinct audio slot names)",
          });
        // The renderer and answer format represent a strict total order against
        // immutable slot positions. Ties/randomized audio mapping need another
        // contract; reject claims of support rather than silently ignoring them.
        if (
          (block.allowTies !== undefined && block.allowTies !== false) ||
          (block.randomizeOrder !== undefined && block.randomizeOrder !== false)
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index],
            message:
              "Ranking ties and randomized presentation are not supported",
          });
      }
      if (block.optionFollowUps !== undefined) {
        if (
          (block.type !== "single_choice" &&
            block.type !== "multiple_choice") ||
          block.optionFollowUps === null ||
          typeof block.optionFollowUps !== "object" ||
          Array.isArray(block.optionFollowUps)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "optionFollowUps"],
            message:
              "Only choice blocks may contain option-specific follow-ups",
          });
        } else {
          const options = new Set(
            Array.isArray(block.options)
              ? (block.options as { id: string }[]).map((o) => o.id)
              : [],
          );
          const all = new Set<string>();
          for (const [optionId, children] of Object.entries(
            block.optionFollowUps as Record<string, unknown>,
          )) {
            if (
              !options.has(optionId) ||
              !Array.isArray(children) ||
              children.length > 8
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["blocks", index, "optionFollowUps", optionId],
                message: "Unknown option or too many children",
              });
              continue;
            }
            children.forEach((child, j) => {
              const c = child as Record<string, unknown>;
              if (
                !c ||
                typeof c !== "object" ||
                typeof c.id !== "string" ||
                !c.id ||
                all.has(c.id) ||
                !["boolean", "number", "text", "callout"].includes(
                  String(c.type),
                ) ||
                typeof c.label !== "string" ||
                !c.label.trim() ||
                typeof c.required !== "boolean"
              )
                ctx.addIssue({
                  code: "custom",
                  path: ["blocks", index, "optionFollowUps", optionId, j],
                  message: "Invalid or duplicate conditional child",
                });
              if (c?.type === "callout" && c.required === true)
                ctx.addIssue({
                  code: "custom",
                  path: ["blocks", index, "optionFollowUps", optionId, j],
                  message: "A display-only callout cannot be required",
                });
              if (typeof c?.id === "string") all.add(c.id);
            });
          }
        }
      }
      /**
       * A display-only block has no answer. `required=true` would falsely imply
       * that the server expects a key in annotation_revisions.answers.
       */
      if (
        ["section", "callout", "audio_player", "transcript_summary"].includes(
          block.type,
        )
      ) {
        if (block.required)
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "required"],
            message: "Display-only blocks must have required=false",
          });
        if (
          (block.type === "section" || block.type === "callout") &&
          block.tone !== undefined &&
          !["neutral", "success", "warning", "info"].includes(
            String(block.tone),
          )
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "tone"],
            message: "Invalid display tone",
          });
        if (
          block.description !== undefined &&
          (typeof block.description !== "string" ||
            block.description.length > 10000)
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "description"],
            message: "Display description must be text, max 10,000 characters",
          });
      }
      if (block.type === "transcript_summary") {
        const source = definition.blocks
          .slice(0, index)
          .find(
            (b) =>
              b.id === block.sourceTimelineBlockId &&
              b.type === "timeline_annotation",
          );
        if (!source)
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "sourceTimelineBlockId"],
            message:
              "Summary must reference an earlier Timeline Grounding block",
          });
        if (
          block.summaryMode !== undefined &&
          !["words", "phones", "both"].includes(String(block.summaryMode))
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "summaryMode"],
            message: "Invalid summary mode",
          });
      }
      /**
       * Timeline data needs a reliable schema even before a single segment
       * exists. We check the tier topology here and *answers* separately on
       * submission. A parent means semantic association, not forced timing.
       */
      if (block.type === "candidate_vote") {
        if (
          block.minimumVotes !== undefined &&
          !z.number().int().min(1).max(1000).safeParse(block.minimumVotes)
            .success
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "minimumVotes"],
            message: "Minimum votes must be 1–1000",
          });
        if (
          block.candidateOrigins !== undefined &&
          !z
            .array(z.enum(["dataset_annotation", "submission", "curated"]))
            .min(1)
            .max(3)
            .refine((origins) => new Set(origins).size === origins.length)
            .safeParse(block.candidateOrigins).success
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "candidateOrigins"],
            message: "Choose distinct allowed candidate source categories",
          });
        if (
          block.allowSelfVote !== undefined &&
          typeof block.allowSelfVote !== "boolean"
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "allowSelfVote"],
            message: "allowSelfVote must be a boolean",
          });
        if (
          block.candidateSource !== undefined &&
          !["curated", "example", "set"].includes(String(block.candidateSource))
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "candidateSource"],
            message: "Unknown candidate source",
          });
        if (
          block.correctionOnValue !== undefined &&
          (!Array.isArray(block.options) ||
            !(block.options as { id: string }[]).some(
              (o) => o.id === block.correctionOnValue,
            ))
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "correctionOnValue"],
            message:
              "Correction trigger must be one of the configured vote options",
          });
        if (
          block.candidatePrompt !== undefined &&
          (typeof block.candidatePrompt !== "string" ||
            block.candidatePrompt.length > 4000)
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "candidatePrompt"],
            message: "Candidate text must be a string under 4,000 characters",
          });
      }
      if (block.type === "timeline_annotation") {
        // The prototype's original Sound/Speech layout is one block, not
        // individually reorderable waveform/spectrogram/tier subblocks.
        if (
          block.groundingMode !== undefined &&
          !["sound", "speech", "flexible"].includes(String(block.groundingMode))
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "groundingMode"],
            message: "Choose Sound or Speech",
          });
        if (
          block.precisionSeconds !== undefined &&
          (typeof block.precisionSeconds !== "number" ||
            block.precisionSeconds < 0.00001 ||
            block.precisionSeconds > 1)
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "precisionSeconds"],
            message: "Invalid timing precision",
          });
        if (
          block.aids !== undefined &&
          (!block.aids ||
            typeof block.aids !== "object" ||
            Array.isArray(block.aids) ||
            Object.values(block.aids as Record<string, unknown>).some(
              (v) => typeof v !== "boolean",
            ))
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "aids"],
            message: "Aids must contain boolean flags",
          });

        const tiers = block.tiers;
        if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 10) {
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, "tiers"],
            message: "Timeline needs between 1 and 10 tiers",
          });
        } else {
          const tierIds = new Set<string>();
          tiers.forEach((tier, j) => {
            if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
              ctx.addIssue({
                code: "custom",
                path: ["blocks", index, "tiers", j],
                message: "Tier must be an object",
              });
              return;
            }
            const t = tier as Record<string, unknown>;
            if (
              typeof t.id !== "string" ||
              !t.id.trim() ||
              tierIds.has(t.id) ||
              typeof t.name !== "string" ||
              !t.name.trim() ||
              t.kind !== "interval"
            )
              ctx.addIssue({
                code: "custom",
                path: ["blocks", index, "tiers", j],
                message:
                  "Each tier requires a unique ID, a name, and interval kind",
              });
            if (typeof t.id === "string") tierIds.add(t.id);
            if (typeof t.allowOverlap !== "boolean")
              ctx.addIssue({
                code: "custom",
                path: ["blocks", index, "tiers", j, "allowOverlap"],
                message: "Tier allowOverlap must be a boolean",
              });
            if (
              !["text", "choice", "ipa", "speaker_id"].includes(
                String(t.labelMode),
              )
            )
              ctx.addIssue({
                code: "custom",
                path: ["blocks", index, "tiers", j, "labelMode"],
                message: "Invalid tier label mode",
              });
          });
          tiers.forEach((tier, j) => {
            if (tier && typeof tier === "object" && !Array.isArray(tier)) {
              const t = tier as Record<string, unknown>;
              if (
                t.parentTierId !== undefined &&
                (typeof t.parentTierId !== "string" ||
                  !tierIds.has(t.parentTierId) ||
                  t.id === t.parentTierId)
              )
                ctx.addIssue({
                  code: "custom",
                  path: ["blocks", index, "tiers", j, "parentTierId"],
                  message: "Parent tier must be another tier in this block",
                });
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

/** Validate nested children with the same block contract, bounded before recursion.
 * Groups repeat answers within one assignment; they do not allocate workers.
 */
function validateGroups(
  definition: { blocks: Array<{ type: string; [key: string]: unknown }> },
  ctx: z.RefinementCtx,
): void {
  function depth(blocks: unknown[], level: number): boolean {
    return (
      level <= 3 &&
      blocks.every(
        (b) =>
          !!b &&
          typeof b === "object" &&
          (!("type" in b) ||
            b.type !== "repeated_group" ||
            ("blocks" in b &&
              Array.isArray(b.blocks) &&
              depth(b.blocks, level + 1))),
      )
    );
  }
  if (!depth(definition.blocks, 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["blocks"],
      message: "Groups support at most three nesting levels",
    });
    return;
  }
  for (const [index, block] of definition.blocks.entries())
    if (block.type === "repeated_group") {
      const min = block.minItems ?? 0,
        max = block.maxItems ?? 20;
      if (
        typeof min !== "number" ||
        typeof max !== "number" ||
        !Number.isInteger(min) ||
        !Number.isInteger(max) ||
        min < 0 ||
        max < Math.max(min, block.required ? 1 : 0) ||
        max > 20
      )
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index],
          message:
            "Group limits must be whole numbers 0–20, maximum >= minimum",
        });
      if (!Array.isArray(block.blocks) || !block.blocks.length) {
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index, "blocks"],
          message: "Group needs child blocks",
        });
        continue;
      }
      if (
        block.blocks.some(
          (child) =>
            child &&
            typeof child === "object" &&
            "sourceBindings" in child &&
            child.sourceBindings,
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["blocks", index, "blocks"],
          message:
            "Repeated child bindings require multi-item snapshot support; use static manual children",
        });
      const parsed = taskDraftSchema.safeParse({
        ...definition,
        blocks: block.blocks,
      });
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({
            code: "custom",
            path: ["blocks", index, ...issue.path],
            message: issue.message,
          });
    }
}
