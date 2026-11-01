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
 * Supported answer types for this lesson:
 * single_choice, multiple_choice, boolean, number, rating_scale, text.
 * We intentionally REJECT advanced block types (timeline_annotation,
 * transcript, ranking, etc.) instead of saving unvalidated research data.
 * Those need their own per-type validators in a later lesson.
 */
import type { PublishedDefinitionData } from "@/lib/contracts/task-instances";

export type AnswerIssue = { blockId: string; message: string };

type Block = PublishedDefinitionData["blocks"][number];
const own = (obj: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(obj, key);

/** Extract option IDs without trusting the JSON data shape. */
function optionIds(block: Block): string[] | null {
  if (!Array.isArray(block.options) || block.options.length < 2) return null;
  const ids: string[] = [];
  for (const option of block.options) {
    if (option === null || typeof option !== "object" || Array.isArray(option)) return null;
    const id = (option as Record<string, unknown>).id;
    if (typeof id !== "string" || !id) return null;
    ids.push(id);
  }
  return new Set(ids).size === ids.length ? ids : null;
}

/** Treat a missing upstream answer as "conditional block hidden". */
function visible(block: Block, answers: Record<string, unknown>): boolean {
  if (block.showWhen === undefined) return true;
  const rule = block.showWhen;
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return false;
  const record = rule as Record<string, unknown>;
  if (typeof record.blockId !== "string" || !own(answers, record.blockId)) return false;
  // For this pilot the Task Builder's condition is an exact scalar equality.
  return Object.is(answers[record.blockId], record.equals);
}

/** Return human-readable issues the Labeller frontend can display per block. */
export function validateAnswers(
  definition: PublishedDefinitionData,
  answers: Record<string, unknown>,
  submitting: boolean
): AnswerIssue[] {
  const issues: AnswerIssue[] = [];
  const blocks = definition.blocks;
  const known = new Set(blocks.map((block) => block.id));

  // Never silently accept extra keys: a typo could lose a human response.
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) issues.push({ blockId: key, message: "Unknown block ID." });
  }

  for (const block of blocks) {
    const shown = visible(block, answers);
    const hasAnswer = own(answers, block.id);

    if (!shown) {
      // A block whose condition is false must not contain stale answers.
      // This avoids saving contradictory labels after a prior choice changes.
      if (hasAnswer) issues.push({ blockId: block.id, message: "Block is hidden by its condition." });
      continue;
    }

    // We do not claim to validate advanced formats until their schemas exist.
    const supported = new Set([
      "single_choice", "multiple_choice", "boolean", "number",
      "rating_scale", "text",
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
        issues.push({ blockId: block.id, message: "Required answer is missing." });
      }
      continue;
    }

    const value = answers[block.id];
    switch (block.type) {
      case "single_choice": {
        const ids = optionIds(block);
        if (!ids || typeof value !== "string" || !ids.includes(value)) {
          issues.push({ blockId: block.id, message: "Choose one valid option ID." });
        }
        break;
      }
      case "multiple_choice": {
        const ids = optionIds(block);
        if (!ids || !Array.isArray(value) || !value.every(v => typeof v === "string" && ids.includes(v)) ||
            new Set(value).size !== value.length) {
          issues.push({ blockId: block.id, message: "Provide unique valid option IDs in an array." });
        } else if (submitting && block.required && value.length === 0) {
          issues.push({ blockId: block.id, message: "Select at least one option." });
        }
        break;
      }
      case "boolean":
        // false is a meaningful answer; never test truthiness for required!
        if (typeof value !== "boolean") issues.push({ blockId: block.id, message: "Answer must be true or false." });
        break;
      case "number":
      case "rating_scale": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          issues.push({ blockId: block.id, message: "Answer must be a finite number." });
          break;
        }
        if (typeof block.min === "number" && value < block.min ||
            typeof block.max === "number" && value > block.max) {
          issues.push({ blockId: block.id, message: "Answer falls outside the configured range." });
        }
        if (block.type === "rating_scale" && !Number.isInteger(value)) {
          issues.push({ blockId: block.id, message: "Rating must be an integer." });
        }
        break;
      }
      case "text":
        if (typeof value !== "string" || value.length > 20000 ||
            (submitting && block.required && !value.trim())) {
          issues.push({ blockId: block.id, message: "Provide valid text (required answers cannot be blank)." });
        }
        break;
    }
  }
  return issues;
}
