/**
 * Lesson 9 — validation of ANSWER VALUES against a FROZEN task definition.
 *
 * Think of the Task Definition as a form schema:
 *   block {id:'voice', type:'single_choice', options:[...]}
 * Then the answer must be {voice:'an-existing-option-id'}.
 *
 * For a draft, missing required answers are fine: the labeller is still
 * working. On final submission, every visible required block must be filled.
 * Supplied values are always validated, including incomplete drafts.
 *
 * Static and server-resolved dataset blocks share these validators, including
 * ordered batches, ranking, timelines and repeated groups. Legacy candidate
 * votes remain readable; new voting authoring is deprecated.
 */
import type { PublishedDefinitionData } from "@/lib/contracts/task-instances";
import { validateTimelineAnswer } from "./timeline-answers";

export type AnswerIssue = { blockId: string; message: string };

type Block = PublishedDefinitionData["blocks"][number];
const own = (obj: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(obj, key);

/** Extract option IDs without trusting the JSON data shape. */
function optionIds(block: Block): string[] | null {
  if (!Array.isArray(block.options) || block.options.length < 2) return null;
  const ids: string[] = [];
  for (const option of block.options) {
    if (option === null || typeof option !== "object" || Array.isArray(option))
      return null;
    const id = (option as Record<string, unknown>).id;
    if (typeof id !== "string" || !id) return null;
    ids.push(id);
  }
  if (ids.includes("__custom__")) return null;
  if (block.allowCustom === true) ids.push("__custom__");
  return new Set(ids).size === ids.length ? ids : null;
}

/** Treat a missing upstream answer as "conditional block hidden". */
function visible(block: Block, answers: Record<string, unknown>): boolean {
  if (block.showWhen === undefined) return true;
  const rule = block.showWhen;
  if (rule === null || typeof rule !== "object" || Array.isArray(rule))
    return false;
  const record = rule as Record<string, unknown>;
  if (typeof record.blockId !== "string" || !own(answers, record.blockId))
    return false;
  // For this pilot the Task Builder's condition is an exact scalar equality.
  const parent = answers[record.blockId];
  const selected =
    parent &&
    typeof parent === "object" &&
    !Array.isArray(parent) &&
    "selection" in parent
      ? (parent as Record<string, unknown>).selection
      : parent;
  return Object.is(selected, record.equals);
}

/** Return human-readable issues the Labeller frontend can display per block. */
export function validateAnswers(
  definition: PublishedDefinitionData,
  answers: Record<string, unknown>,
  submitting: boolean,
  context?: {
    audioAssetCount?: number;
    candidateIds?: string[];
    candidateSets?: import("@/lib/contracts/candidate-sets").CandidateSelectionContext;
  },
): AnswerIssue[] {
  const issues: AnswerIssue[] = [];
  const blocks = definition.blocks;
  const known = new Set(blocks.map((block) => block.id));

  // Never silently accept extra keys: a typo could lose a human response.
  for (const key of Object.keys(answers)) {
    if (!known.has(key))
      issues.push({ blockId: key, message: "Unknown block ID." });
  }

  for (const block of blocks) {
    const shown = visible(block, answers);
    const hasAnswer = own(answers, block.id);

    if (!shown) {
      // A block whose condition is false must not contain stale answers.
      // This avoids saving contradictory labels after a prior choice changes.
      if (hasAnswer)
        issues.push({
          blockId: block.id,
          message: "Block is hidden by its condition.",
        });
      continue;
    }

    /**
     * Display-only blocks still participate in conditional visibility, but
     * must never produce an annotation answer. This is more precise than
     * treating them as unsupported question types or inventing empty answers.
     */
    if (
      ["section", "callout", "audio_player", "transcript_summary"].includes(
        block.type,
      )
    ) {
      if (hasAnswer)
        issues.push({
          blockId: block.id,
          message: "Display-only blocks cannot contain an answer.",
        });
      continue;
    }
    /**
     * NUM_BATCH > 1 repeats one configuration across the ORDERED Task Instance
     * recordings. Answers live in answers[block.id][audioIndex]. They are NOT
     * separately assigned tasks and must not be shuffled after submission.
     * For comparisons, groups = WAV count / comparisonSize instead.
     */
    const numBatch = typeof block.numBatch === "number" ? block.numBatch : 1;
    if (
      numBatch > 1 &&
      [
        "single_choice",
        "multiple_choice",
        "boolean",
        "number",
        "text",
        "transcript",
        "rating_scale",
        "timeline_annotation",
      ].includes(block.type)
    ) {
      if (
        !Number.isInteger(numBatch) ||
        numBatch > 24 ||
        (context?.audioAssetCount !== undefined &&
          numBatch > context.audioAssetCount)
      ) {
        issues.push({
          blockId: block.id,
          message: "NUM_BATCH exceeds the bound task audio assets (24 max).",
        });
        continue;
      }
      const vals = answers[block.id];
      // Omission is not a malformed batch: optional aids and untouched drafts
      // need not manufacture one empty answer for every recording. Supplied
      // values still pass the exact same panel validators as required answers.
      if (!hasAnswer && (!submitting || !block.required)) continue;
      if (
        !Array.isArray(vals) ||
        vals.length > numBatch ||
        (submitting && block.required && vals.length !== numBatch)
      ) {
        issues.push({
          blockId: block.id,
          message: `Expected ${numBatch} per-audio answer entries.`,
        });
        continue;
      }
      // Derived panel schemas come only from pinned server inputs, never request options.
      const single = { ...block, numBatch: 1 };
      vals.forEach((entry, index) => {
        const panel = Array.isArray(block.batchBlocks)
          ? (block.batchBlocks[index] as Block)
          : single;
        // A draft can contain untouched audio panels, but a final submit
        // cannot omit them. React uses null for an untouched array slot.
        if (
          (!submitting || !block.required) &&
          (entry === null || entry === undefined)
        )
          return;
        const nested = validateAnswers(
          { ...definition, blocks: [panel] },
          { [block.id]: entry },
          submitting,
          context,
        );
        nested.forEach((issue) =>
          issues.push({
            blockId: block.id,
            message: `Audio ${index + 1}: ${issue.message}`,
          }),
        );
      });
      continue;
    }
    if (block.type === "audio_comparison") {
      const per =
        typeof block.comparisonSize === "number" ? block.comparisonSize : 2;
      const n = typeof block.numBatch === "number" ? block.numBatch : 2;
      if (
        !Number.isInteger(per) ||
        per < 2 ||
        per > 4 ||
        !Number.isInteger(n) ||
        n < per ||
        n > 24 ||
        n % per !== 0 ||
        (context?.audioAssetCount !== undefined && context.audioAssetCount < n)
      ) {
        issues.push({
          blockId: block.id,
          message:
            "Comparison requires 2–4 WAVs per panel and an exactly divisible audio batch (max 24).",
        });
        continue;
      }
      // Untouched drafts and optional comparisons may be omitted. Supplied
      // arrays still use one frozen option ID per ordered recording group;
      // null placeholders are allowed only while drafting incomplete panels.
      if (!hasAnswer && (!submitting || !block.required)) continue;
      const options = optionIds(block);
      const ans = answers[block.id];
      if (
        !Array.isArray(ans) ||
        ans.length > n / per ||
        (submitting && ans.length !== n / per) ||
        !options ||
        ans.some((v) =>
          (v === null || v === undefined) && !submitting
            ? false
            : typeof v !== "string" || !options.includes(v),
        )
      ) {
        issues.push({
          blockId: block.id,
          message: `Expected ${n / per} valid comparison choices.`,
        });
      }
      continue;
    }
    if (block.type === "ranking") {
      const mode = block.rankingMode === "labels" ? "labels" : "audios";
      const rankIds =
        mode === "labels" && Array.isArray(block.rankLabels)
          ? (block.rankLabels as { id: string }[]).map((o) => o.id)
          : (Array.isArray(block.stimulusSlots) ? block.stimulusSlots : []).map(
              (_, i) => `slot-${i}`,
            );
      if (
        mode === "audios" &&
        context?.audioAssetCount !== undefined &&
        context.audioAssetCount < rankIds.length
      ) {
        issues.push({
          blockId: block.id,
          message: "Not enough task audio assets to rank.",
        });
        continue;
      }
      // Omission is different from a supplied malformed value. Untouched drafts
      // and omitted optional final answers have no ranking; explicit null does
      // not mean "clear". Clearing a ranking removes its key from answers.
      if (!hasAnswer && (!submitting || !block.required)) continue;
      const ans = answers[block.id];
      if (
        rankIds.length < 2 ||
        rankIds.length > 12 ||
        !Array.isArray(ans) ||
        ans.length > rankIds.length ||
        (submitting && ans.length !== rankIds.length) ||
        new Set(rankIds).size !== rankIds.length ||
        new Set(ans).size !== ans.length ||
        ans.some((v) => typeof v !== "string" || !rankIds.includes(v))
      ) {
        issues.push({
          blockId: block.id,
          message: submitting
            ? "Ranking must contain each configured stable ID exactly once, in ranked order."
            : "Ranking draft must be an ordered array of distinct configured stable IDs.",
        });
      }
      continue;
    }
    // We do not claim to validate remaining unsupported formats until schemas exist.
    if (block.type === "repeated_group") {
      const entries = answers[block.id];
      if (!hasAnswer && (!submitting || !block.required)) continue;
      const min = Math.max(Number(block.minItems ?? 0), block.required ? 1 : 0);
      const max = Number(block.maxItems ?? 20);
      if (
        !Array.isArray(entries) ||
        entries.length > max ||
        (submitting && entries.length < min)
      ) {
        issues.push({
          blockId: block.id,
          message: "Invalid repeated entry count",
        });
        continue;
      }
      const ids = new Set<string>();
      for (const entry of entries) {
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.id !== "string" ||
          !entry.id.trim() ||
          ids.has(entry.id) ||
          Object.keys(entry).some((key) => !["id", "answers"].includes(key)) ||
          !entry.answers ||
          typeof entry.answers !== "object" ||
          Array.isArray(entry.answers)
        ) {
          issues.push({
            blockId: block.id,
            message:
              "Repeated entries need distinct stable IDs and answer objects",
          });
          continue;
        }
        ids.add(entry.id);
        const nested = validateAnswers(
          {
            ...definition,
            blocks: block.blocks as PublishedDefinitionData["blocks"],
          },
          entry.answers,
          submitting,
          context,
        );
        for (const issue of nested)
          issues.push({
            blockId: `${block.id}.${entry.id}.${issue.blockId}`,
            message: issue.message,
          });
      }
      continue;
    }

    const supported = new Set([
      "single_choice",
      "multiple_choice",
      "boolean",
      "number",
      "rating_scale",
      "text",
      "transcript",
      "timeline_annotation",
      "candidate_vote",
    ]);
    if (!supported.has(block.type)) {
      issues.push({
        blockId: block.id,
        message: `Answer validation for '${block.type}' is not implemented yet; do not assign this protocol for real submissions.`,
      });
      continue;
    }

    if (!hasAnswer) {
      if (submitting && block.required) {
        issues.push({
          blockId: block.id,
          message: "Required answer is missing.",
        });
      }
      continue;
    }

    const value = answers[block.id];
    switch (block.type) {
      case "single_choice": {
        const ids = optionIds(block);
        const raw =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        const selected = raw ? raw.selection : value;
        if (!ids || typeof selected !== "string" || !ids.includes(selected)) {
          issues.push({
            blockId: block.id,
            message: "Choose one valid option ID.",
          });
          break;
        }
        validateOptionChildren(block, raw, [selected], submitting, issues);
        break;
      }
      case "multiple_choice": {
        const ids = optionIds(block);
        const raw =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        const selected = raw ? raw.selection : value;
        if (
          !ids ||
          !Array.isArray(selected) ||
          !selected.every((v) => typeof v === "string" && ids.includes(v)) ||
          new Set(selected).size !== selected.length
        ) {
          issues.push({
            blockId: block.id,
            message: "Provide unique valid option IDs in an array.",
          });
          break;
        }
        const min = Math.max(
          typeof block.minSelections === "number" ? block.minSelections : 0,
          submitting && block.required ? 1 : 0,
        );
        if (submitting && selected.length < min)
          issues.push({
            blockId: block.id,
            message: `Select at least ${min} option(s).`,
          });
        if (
          typeof block.maxSelections === "number" &&
          selected.length > block.maxSelections
        )
          issues.push({
            blockId: block.id,
            message: "Too many options selected.",
          });
        validateOptionChildren(
          block,
          raw,
          selected as string[],
          submitting,
          issues,
        );
        break;
      }
      case "boolean":
        // false is a meaningful answer; never test truthiness for required!
        if (typeof value !== "boolean")
          issues.push({
            blockId: block.id,
            message: "Answer must be true or false.",
          });
        // A verification checkbox must explicitly contain the required
        // value; `false` remains a valid Boolean in ordinary questions.
        else if (
          submitting &&
          typeof block.requiredValue === "boolean" &&
          value !== block.requiredValue
        )
          issues.push({
            blockId: block.id,
            message: "Confirmation has the wrong required value.",
          });
        break;
      case "number":
      case "rating_scale": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          issues.push({
            blockId: block.id,
            message: "Answer must be a finite number.",
          });
          break;
        }
        if (
          (typeof block.min === "number" && value < block.min) ||
          (typeof block.max === "number" && value > block.max)
        ) {
          issues.push({
            blockId: block.id,
            message: "Answer falls outside the configured range.",
          });
        }
        if (
          block.type === "number" &&
          block.integerOnly === true &&
          !Number.isInteger(value)
        )
          issues.push({
            blockId: block.id,
            message: "Value must be a whole number.",
          });
        if (
          block.type === "rating_scale" &&
          (!Number.isInteger(value) ||
            (typeof block.step === "number" &&
              block.step > 0 &&
              Math.abs(
                (value - (typeof block.min === "number" ? block.min : 0)) /
                  block.step -
                  Math.round(
                    (value - (typeof block.min === "number" ? block.min : 0)) /
                      block.step,
                  ),
              ) > 1e-7))
        )
          issues.push({
            blockId: block.id,
            message: "Rating must use a configured scale step.",
          });
        break;
      }
      case "text":
      case "transcript":
        if (
          typeof value !== "string" ||
          value.length >
            (typeof block.maxLength === "number" ? block.maxLength : 20000) ||
          (submitting && block.required && !value.trim())
        ) {
          issues.push({
            blockId: block.id,
            message: "Provide valid text (required answers cannot be blank).",
          });
        }
        break;
      case "candidate_vote": {
        /** Client labels are presentation; only the stable option ID persists. */
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          issues.push({
            blockId: block.id,
            message: "Candidate vote must be an object.",
          });
          break;
        }
        const vote = value as Record<string, unknown>;
        if (block.candidateSource === "set") {
          // No client-provided list or revision is authoritative. Both IDs must
          // belong to the immutable set for THIS block/assignment, after policy
          // filtering. Supplied draft votes are checked as strictly as submits.
          const set = context?.candidateSets?.[block.id];
          if (
            !set ||
            vote.candidateSetSnapshotId !== set.id ||
            typeof vote.selectedCandidateId !== "string" ||
            !set.candidateIds.includes(vote.selectedCandidateId)
          )
            issues.push({
              blockId: block.id,
              message:
                "Choose an eligible candidate from this block's current candidate set.",
            });
          if (
            Object.keys(vote).some(
              (key) =>
                !["candidateSetSnapshotId", "selectedCandidateId"].includes(
                  key,
                ),
            )
          )
            issues.push({
              blockId: block.id,
              message: "Candidate selection contains unexpected fields.",
            });
          break;
        }
        const ids = optionIds(block) ?? ["AGREE", "DISAGREE", "UNSURE"];
        if (typeof vote.value !== "string" || !ids.includes(vote.value))
          issues.push({
            blockId: block.id,
            message: "Choose a configured candidate vote option.",
          });
        if (
          vote.correctedText !== undefined &&
          (typeof vote.correctedText !== "string" ||
            vote.correctedText.length > 20000)
        )
          issues.push({
            blockId: block.id,
            message: "Invalid correction text.",
          });
        const trigger =
          typeof block.correctionOnValue === "string"
            ? block.correctionOnValue
            : "DISAGREE";
        if (
          submitting &&
          block.allowCorrection === true &&
          vote.value === trigger &&
          (typeof vote.correctedText !== "string" || !vote.correctedText.trim())
        )
          issues.push({
            blockId: block.id,
            message: "A correction is required for this vote option.",
          });
        if (
          block.candidateSource !== "example" &&
          (submitting || vote.candidateId !== undefined)
        ) {
          if (
            typeof vote.candidateId !== "string" ||
            !context?.candidateIds?.includes(vote.candidateId)
          )
            issues.push({
              blockId: block.id,
              message:
                "Choose a candidate annotation curated for this Task Instance.",
            });
        }
        for (const k of Object.keys(vote))
          if (!["value", "correctedText", "candidateId"].includes(k))
            issues.push({
              blockId: block.id,
              message: `Unexpected vote field '${k}'.`,
            });
        break;
      }
      case "timeline_annotation": {
        const result = validateTimelineAnswer(
          block.tiers,
          value,
          block.required,
          submitting,
        );
        for (const message of result)
          issues.push({ blockId: block.id, message });
        break;
      }
    }
  }
  return issues;
}

/**
 * Validate inline controls nested under ONE selected choice without creating
 * a second top-level answer key. They are only active when their parent option
 * is selected. This prevents saving a contradictory stale confirmation.
 *
 * Legacy choice without any follow-ups remains a string/string[].
 * With follow-ups its answer is {selection:string|string[],children:{childId:value}}.
 */
function validateOptionChildren(
  block: Block,
  raw: Record<string, unknown> | null,
  selected: string[],
  submitting: boolean,
  issues: AnswerIssue[],
) {
  const custom = selected.includes("__custom__");
  if (custom && block.allowCustom !== true)
    issues.push({ blockId: block.id, message: "Custom answers are disabled." });
  if (
    custom &&
    (!raw ||
      typeof raw.customText !== "string" ||
      raw.customText.length > 20000 ||
      (submitting && !raw.customText.trim()))
  )
    issues.push({
      blockId: block.id,
      message: "Custom answer requires text (20000 characters max).",
    });
  if (raw && !custom && "customText" in raw)
    issues.push({
      blockId: block.id,
      message: "Custom text requires the Custom option.",
    });
  // A custom answer shares the existing selection envelope, so old scalar/array
  // answers and option-specific children retain their historical wire shapes.
  if (raw && custom)
    for (const key of Object.keys(raw))
      if (!["selection", "children", "customText"].includes(key))
        issues.push({
          blockId: block.id,
          message: `Unexpected custom field ${key}.`,
        });
  const groups = block.optionFollowUps;
  if (
    custom &&
    raw &&
    "children" in raw &&
    (!groups ||
      typeof groups !== "object" ||
      !Object.values(groups).some(
        (items) => Array.isArray(items) && items.length,
      ))
  )
    issues.push({
      blockId: block.id,
      message: "Custom answer has unexpected child answers.",
    });
  if (!groups || typeof groups !== "object") {
    if (raw && !custom)
      issues.push({
        blockId: block.id,
        message: "This choice must save a scalar or array, not an object.",
      });
    return;
  }
  const entries = Object.entries(groups as Record<string, unknown>);
  if (!entries.some(([, items]) => Array.isArray(items) && items.length)) {
    if (raw && !custom)
      issues.push({
        blockId: block.id,
        message: "Unexpected nested choice value.",
      });
    return;
  }
  if (!raw) {
    issues.push({
      blockId: block.id,
      message: "Nested choice answers need {selection,children}.",
    });
    return;
  }
  for (const key of Object.keys(raw))
    if (
      !["selection", "children", ...(custom ? ["customText"] : [])].includes(
        key,
      )
    )
      issues.push({
        blockId: block.id,
        message: `Unexpected nested field ${key}.`,
      });
  const children =
    raw.children &&
    typeof raw.children === "object" &&
    !Array.isArray(raw.children)
      ? (raw.children as Record<string, unknown>)
      : {};
  const active = new Map<string, Record<string, unknown>>();
  for (const [optionId, items] of entries) {
    if (!selected.includes(optionId) || !Array.isArray(items)) continue;
    for (const child of items) {
      if (!child || typeof child !== "object" || Array.isArray(child)) continue;
      const c = child as Record<string, unknown>;
      if (typeof c.id === "string" && c.type !== "callout") active.set(c.id, c);
    }
  }
  for (const k of Object.keys(children)) {
    if (!active.has(k))
      issues.push({
        blockId: block.id,
        message: `Hidden or unknown conditional child '${k}'.`,
      });
  }
  for (const [id, child] of active) {
    const has = Object.prototype.hasOwnProperty.call(children, id);
    if (!has) {
      if (submitting && child.required === true)
        issues.push({
          blockId: block.id,
          message: `Required follow-up '${child.label}' is missing.`,
        });
      continue;
    }
    const v = children[id];
    if (
      child.type === "boolean" &&
      (typeof v !== "boolean" ||
        (submitting &&
          child.requiredValue !== undefined &&
          v !== child.requiredValue))
    )
      issues.push({
        blockId: block.id,
        message: `Invalid Yes/No follow-up '${child.label}'.`,
      });
    if (
      child.type === "text" &&
      (typeof v !== "string" ||
        (submitting && child.required === true && !v.trim()))
    )
      issues.push({
        blockId: block.id,
        message: `Invalid text follow-up '${child.label}'.`,
      });
    if (
      child.type === "number" &&
      (typeof v !== "number" || !Number.isFinite(v))
    )
      issues.push({
        blockId: block.id,
        message: `Invalid number follow-up '${child.label}'.`,
      });
  }
}
