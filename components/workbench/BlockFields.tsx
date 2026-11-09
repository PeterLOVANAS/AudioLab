"use client";
/**
 * Shared question renderer. Preserve this public interface when integrating
 * Friend D's Labeller Workspace. Both the preview and real assignment should
 * call this same component; only the *parent* owns draft persistence.
 */
import AudioGroundingEditor, {
  AudioWaveformPlayer,
  type GroundingAnswer,
} from "@/components/audio-editor/AudioGroundingEditor";
import { phoneticSummary } from "@/lib/audio/phonetics";
import {
  AudioComparisonControl,
  RankingControl,
  FollowUps,
  type AssetSample,
} from "./AdvancedControls";
import { useEffect, useId, useState } from "react";
import { editable, title, type Block } from "../task-builder/model";

// Answers live outside the block definitions. This lets the labeller page reuse the controls.
export type Answers = Record<string, unknown>;
type Item = { id: string; answers: Answers };
export type Samples = {
  candidateText?: string;
  candidateId?: string;
  batchAudio?: AssetSample[];
  audio?: Record<string, string>;
  primaryUrl?: string;
  primaryMeta?: {
    durationSeconds?: number;
    sampleRate?: number;
    channels?: number;
  };
};
type Props = {
  blocks: Block[];
  answers: Answers;
  onChange: (answers: Answers) => void;
  samples?: Samples;
  allowLocalAudio?: boolean;
};
function object(value: unknown): Answers {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Answers)
    : {};
}
/** Choice blocks with option-specific children save {selection,children}.
 * Plain single-choice remains a string for backwards compatibility. */
function selectionOf(value: unknown): unknown {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "selection")
    ? (value as Answers).selection
    : value;
}
function visible(block: Block, answers: Answers) {
  return (
    !block.showWhen ||
    (Object.hasOwn(answers, block.showWhen.blockId) &&
      Object.is(
        selectionOf(answers[block.showWhen.blockId]),
        block.showWhen.equals,
      ))
  );
}
// Rebuild in definition order so switching an earlier answer also clears hidden descendants.
function visibleAnswers(blocks: Block[], proposed: Answers) {
  const kept: Answers = {};
  for (const block of blocks) {
    if (
      visible(block, kept) &&
      Object.hasOwn(proposed, block.id) &&
      proposed[block.id] !== undefined
    )
      kept[block.id] = proposed[block.id];
  }
  return kept;
}
function answerProblem(block: Block, value: unknown): string | undefined {
  // Presentational blocks deliberately produce no annotation value.
  if (
    ["section", "callout", "audio_player", "transcript_summary"].includes(
      block.type,
    )
  )
    return;
  const batch = block.numBatch ?? 1;
  if (
    batch > 1 &&
    block.type !== "audio_comparison" &&
    block.type !== "ranking" &&
    block.type !== "candidate_vote"
  ) {
    if (!Array.isArray(value) || value.length !== batch)
      return `Answer every one of the ${batch} audio panels.`;
    const single = { ...block, numBatch: 1 };
    for (let i = 0; i < batch; i++) {
      const problem = answerProblem(single, value[i]);
      if (problem) return `Audio ${i + 1}: ${problem}`;
    }
    return;
  }
  if (block.type === "audio_comparison") {
    const groups = (block.numBatch ?? 2) / (block.comparisonSize ?? 2);
    const ids = new Set(block.options?.map((o) => o.id));
    if (
      !Array.isArray(value) ||
      value.length !== groups ||
      value.some((v) => !ids.has(v))
    )
      return `Choose an answer for each of ${groups} comparisons.`;
    return;
  }
  if (block.type === "ranking") {
    const ids =
      block.rankingMode === "labels"
        ? (block.rankLabels ?? []).map((o) => o.id)
        : (block.stimulusSlots ?? []).map((_, i) => `slot-${i}`);
    if (
      !Array.isArray(value) ||
      value.length !== ids.length ||
      new Set(value).size !== ids.length ||
      value.some((v) => !ids.includes(v))
    )
      return "Rank each item exactly once.";
    return;
  }
  if (["single_choice", "multiple_choice"].includes(block.type)) {
    const selected = selectionOf(value);
    const selectedIds =
      typeof selected === "string"
        ? [selected]
        : Array.isArray(selected)
          ? selected
          : [];
    const children = block.optionFollowUps ?? {};
    if (Object.values(children).some((arr) => arr.length)) {
      const sub = object(object(value).children);
      for (const optionId of selectedIds) {
        for (const child of children[optionId] ?? []) {
          if (child.type === "callout" || !child.required) continue;
          const v = sub[child.id];
          if (
            v === undefined ||
            v === "" ||
            (child.type === "boolean" && typeof v !== "boolean") ||
            (child.type === "boolean" &&
              child.requiredValue !== undefined &&
              child.requiredValue !== v)
          )
            return `Follow-up '${child.label}' is required.`;
        }
      }
    }
  }
  if (!editable(block.type)) return;
  if (
    value === undefined ||
    value === "" ||
    (typeof value === "string" && !value.trim())
  )
    return block.required ? "An answer is required." : undefined;
  if (
    block.type === "boolean" &&
    block.requiredValue !== undefined &&
    block.requiredValue !== value
  )
    return "Check the accepted Yes / No value.";
  if (block.type === "multiple_choice" && Array.isArray(value)) {
    const minimum = Math.max(block.minSelections ?? 0, block.required ? 1 : 0);
    if (
      value.length < minimum ||
      value.length > (block.maxSelections ?? Infinity)
    )
      return "Check the number of selected answers.";
  }
  if (block.type === "number" || block.type === "rating_scale") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < (block.min ?? -Infinity) ||
      value > (block.max ?? Infinity)
    )
      return "Enter a number in range.";
    if (block.integerOnly && !Number.isInteger(value))
      return "Use a whole number.";
    if (
      block.type === "rating_scale" &&
      (!Number.isInteger(value) ||
        (value - (block.min ?? 0)) % (block.step || 1) !== 0)
    )
      return "Use a marked step on the scale.";
  }
  if (
    block.type === "text" &&
    typeof value === "string" &&
    value.length > (block.maxLength ?? 20000)
  )
    return "Shorten this answer.";
  if (block.type === "candidate_vote") {
    const vote = object(value);
    const ids = block.options?.map((o) => o.id) ?? [
      "AGREE",
      "DISAGREE",
      "UNSURE",
    ];
    if (!ids.includes(String(vote.value ?? "")))
      return "Choose a valid vote option.";
    if (
      block.allowCorrection &&
      vote.value === (block.correctionOnValue ?? "DISAGREE") &&
      !String(vote.correctedText ?? "").trim()
    )
      return "Provide the suggested correction.";
  }
  if (block.type === "timeline_annotation") {
    // Preview checks the same canonical shape as the server, but only the
    // backend can be authoritative for a submitted annotation revision.
    const data = object(value);
    if (!object(data.tiers)) return "Timeline needs a 'tiers' object.";
    if (
      block.required &&
      !(block.tiers ?? []).some(
        (t) =>
          Array.isArray((data.tiers as Answers)[t.id]) &&
          ((data.tiers as Answers)[t.id] as unknown[]).length > 0,
      )
    )
      return "Label at least one time interval.";
  }
  if (block.type === "repeated_group") {
    const count = Array.isArray(value) ? value.length : 0;
    if (
      count < Math.max(block.minItems ?? 0, block.required ? 1 : 0) ||
      count > (block.maxItems ?? Infinity)
    )
      return "Check the number of repeated items.";
  }
}
export function checkAnswers(blocks: Block[], answers: Answers): string[] {
  const problems: string[] = [];
  for (const block of blocks) {
    if (!visible(block, answers)) continue;
    const problem = answerProblem(block, answers[block.id]);
    if (problem) problems.push(block.label + " · " + problem);
    if (block.type === "repeated_group") {
      const items = (answers[block.id] ?? []) as Item[];
      items.forEach((item, index) => {
        for (const detail of checkAnswers(block.blocks ?? [], item.answers))
          problems.push(
            (block.itemLabel || "Item") + " " + (index + 1) + " · " + detail,
          );
      });
    }
  }
  return problems;
}
function Recording({
  slot,
  url,
  allowLocal,
}: {
  slot: string;
  url?: string;
  allowLocal?: boolean;
}) {
  const [file, setFile] = useState<File>();
  const [localUrl, setLocalUrl] = useState("");
  useEffect(() => {
    if (!file) return;
    const source = URL.createObjectURL(file);
    setLocalUrl(source);
    return () => URL.revokeObjectURL(source);
  }, [file]);
  return (
    <div className="tb-recording">
      <b>{slot || "Unnamed slot"}</b>
      {(url || localUrl) && (
        <audio aria-label={slot} controls src={url || localUrl} />
      )}
      {!url && allowLocal && (
        <label>
          Try a local recording
          <input
            type="file"
            accept="audio/*"
            aria-label={"Try audio for " + slot}
            onChange={(event) => setFile(event.target.files?.[0])}
          />
        </label>
      )}
      {!url && !allowLocal && <small>Recording pending</small>}
    </div>
  );
}
function Recordings({
  block,
  samples,
  allowLocal,
  ranks,
  onRank,
}: {
  block: Block;
  samples?: Samples;
  allowLocal?: boolean;
  ranks?: Answers;
  onRank?: (slot: string, rank?: number) => void;
}) {
  const slots = block.stimulusSlots ?? [];
  const [order, setOrder] = useState<string[]>();
  const slotKey = JSON.stringify(slots);
  useEffect(() => {
    const ordered = JSON.parse(slotKey) as string[];
    if (block.randomizeOrder) {
      for (let end = ordered.length - 1; end > 0; end--) {
        const pick = Math.floor(Math.random() * (end + 1));
        [ordered[end], ordered[pick]] = [ordered[pick], ordered[end]];
      }
    }
    setOrder(ordered);
  }, [slotKey, block.randomizeOrder]);
  return (
    <div className="tb-recordings">
      {(order ?? slots).map((slot, index) => (
        <div key={index}>
          <Recording
            slot={slot}
            url={samples?.audio?.[slot]}
            allowLocal={allowLocal}
          />
          {onRank && (
            <label className="tb-field">
              <span>Rank for {slot}</span>
              <select
                aria-label={"Rank for " + slot}
                value={String(ranks?.[slot] ?? "")}
                onChange={(event) =>
                  onRank(
                    slot,
                    event.target.value ? Number(event.target.value) : undefined,
                  )
                }
              >
                <option value="">Choose rank</option>
                {slots.map((_, position) => (
                  <option key={position} value={position + 1}>
                    {position + 1}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      ))}
    </div>
  );
}
function AnswerControl({
  block,
  value,
  change,
  samples,
  allowLocalAudio,
}: {
  block: Block;
  value: unknown;
  change: (value: unknown) => void;
  samples?: Samples;
  allowLocalAudio?: boolean;
}) {
  const name = useId(); // Each repeated item gets its own radio group.
  // NUM_BATCH counts actual audio assets, not UI repetitions. An audio pair
  // comparison is deliberately rendered separately (NUM_BATCH 8 -> 4 pairs).
  const total = block.numBatch ?? 1;
  if (block.type === "audio_comparison")
    return (
      <AudioComparisonControl
        block={block}
        value={value}
        assets={samples?.batchAudio ?? []}
        onChange={change}
      />
    );
  if (block.type === "ranking")
    return (
      <RankingControl
        block={block}
        value={value}
        assets={samples?.batchAudio ?? []}
        onChange={change}
      />
    );
  if (
    total > 1 &&
    [
      "single_choice",
      "multiple_choice",
      "boolean",
      "number",
      "text",
      "rating_scale",
      "audio_player",
      "timeline_annotation",
    ].includes(block.type)
  ) {
    const items = Array.isArray(value) ? value : [];
    const single = { ...block, numBatch: 1 };
    return (
      <div className="tb-batch-grid">
        {Array.from({ length: total }, (_, index) => {
          const selected = samples?.batchAudio?.[index];
          const local = {
            ...samples,
            primaryUrl: selected?.url,
            primaryMeta: undefined,
          };
          return (
            <section className="tb-batch-card" key={index}>
              <h4>
                Audio {index + 1} of {total}
              </h4>
              {selected?.url &&
                block.type !== "audio_player" &&
                block.type !== "timeline_annotation" && (
                  <audio controls preload="none" src={selected.url} />
                )}
              {!selected && (
                <small>
                  Audio asset #{index + 1} must be selected in the preview or
                  Task Instance.
                </small>
              )}
              <AnswerControl
                block={single}
                value={items[index]}
                samples={local}
                allowLocalAudio={allowLocalAudio}
                change={(v) =>
                  change(
                    Array.from({ length: total }, (_, j) =>
                      j === index ? v : (items[j] ?? null),
                    ),
                  )
                }
              />
            </section>
          );
        })}
      </div>
    );
  }
  const options = block.options ?? [];
  // Only choice questions get these styles. Older saved questions have no
  // appearance field, so they fall back to the original bullet-point layout.
  const isChoice =
    block.type === "single_choice" || block.type === "multiple_choice";
  const appearance = isChoice
    ? (block.answerAppearance ?? "bullets")
    : undefined;
  const optionsClass =
    "tb-options" +
    (isChoice ? " tb-choice-options tb-choice-" + appearance : "");
  function pick(
    values: { id: string; label: string; description?: string }[],
    selected: unknown,
    choose: (id: string) => void,
  ) {
    // All appearances use the same answer IDs and native radio inputs.
    // Styling therefore does not change which answer gets saved.
    return (
      <div className={optionsClass}>
        {values.map((option, index) => (
          <label key={option.id || index} className="tb-pick">
            <input
              type="radio"
              name={name}
              checked={selected === option.id}
              onChange={() => choose(option.id)}
            />
            <span>{option.label || "Unnamed choice"}</span>
            {appearance === "cards" && option.description && (
              <small className="tb-choice-description">
                {option.description}
              </small>
            )}
          </label>
        ))}
      </div>
    );
  }
  switch (block.type) {
    case "single_choice": {
      const selection = selectionOf(value);
      const hasFollowUps = Object.values(block.optionFollowUps ?? {}).some(
        (a) => a.length > 0,
      );
      const sub = object(object(value).children);
      const children = block.optionFollowUps?.[String(selection)] ?? [];
      return (
        <>
          {pick(options, selection, (id) =>
            change(hasFollowUps ? { selection: id, children: {} } : id),
          )}
          {children.length > 0 && (
            <FollowUps
              items={children}
              answers={sub}
              onChange={(next) => change({ selection, children: next })}
            />
          )}
        </>
      );
    }
    case "multiple_choice": {
      // Checkboxes allow several answers; the appearance never changes the limit.
      const choice = selectionOf(value);
      const selected: string[] = Array.isArray(choice) ? choice : [];
      const hasFollowUps = Object.values(block.optionFollowUps ?? {}).some(
        (a) => a.length > 0,
      );
      const sub = object(object(value).children);
      return (
        <div className={optionsClass}>
          {options.map((option) => (
            <label className="tb-pick" key={option.id}>
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                disabled={
                  !selected.includes(option.id) &&
                  selected.length >= (block.maxSelections ?? Infinity)
                }
                onChange={(event) =>
                  change(
                    (() => {
                      const next = event.target.checked
                        ? [...selected, option.id]
                        : selected.filter((id) => id !== option.id);
                      return hasFollowUps
                        ? { selection: next, children: sub }
                        : next;
                    })(),
                  )
                }
              />
              <span>{option.label}</span>
              {appearance === "cards" && option.description && (
                <small className="tb-choice-description">
                  {option.description}
                </small>
              )}
            </label>
          ))}
          {selected.flatMap((id) => block.optionFollowUps?.[id] ?? []).length >
            0 && (
            <FollowUps
              items={selected.flatMap(
                (id) => block.optionFollowUps?.[id] ?? [],
              )}
              answers={sub}
              onChange={(next) =>
                change({ selection: selected, children: next })
              }
            />
          )}
        </div>
      );
    }
    case "boolean": {
      // Preserve the prototype's conditional "full listening confirmed"
      // checkbox. This is NOT merely a green decoration: clicking the box
      // stores a real Boolean under this block's stable ID, and the server
      // rejects false if requiredValue=true on final submission.
      if (block.requiredValue === true) {
        return (
          <label className="r-confirm tb-prototype-confirm">
            <input
              type="checkbox"
              checked={value === true}
              onChange={(e) => change(e.target.checked)}
            />
            <span>
              {block.helpText ||
                "I listened to the entire recording and confirm this answer."}
            </span>
          </label>
        );
      }
      return pick(
        [
          { id: "true", label: "Yes" },
          { id: "false", label: "No" },
        ],
        String(value),
        (id) => change(id === "true"),
      );
    }
    case "rating_scale": {
      const { min = 1, max = 5, step = 1 } = block;
      const count = Math.floor((max - min) / step) + 1;
      if (block.ratingAppearance === "slider")
        return (
          <div className="tb-rating-slider">
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={typeof value === "number" ? value : min}
              onChange={(e) => change(e.target.valueAsNumber)}
            />
            <output>{typeof value === "number" ? value : "Not rated"}</output>
            <div className="tb-between">
              <small>{block.minLabel ?? min}</small>
              <small>{block.maxLabel ?? max}</small>
            </div>
          </div>
        );
      if (Number.isInteger(count) && count > 0 && count <= 12) {
        const choices = Array.from({ length: count }, (_, position) =>
          String(min + position * step),
        );
        return (
          <>
            {pick(
              choices.map((id) => ({ id, label: id })),
              String(value),
              (id) => change(Number(id)),
            )}
            <small>
              {[block.minLabel, block.maxLabel].filter(Boolean).join(" — ")}
            </small>
          </>
        );
      }
      return (
        <input
          aria-label={block.label}
          type="number"
          min={min}
          max={max}
          step={step}
          placeholder={min + " – " + max}
          value={typeof value === "number" ? value : ""}
          onChange={(event) =>
            change(event.target.value ? event.target.valueAsNumber : undefined)
          }
        />
      );
    }
    case "number":
      return (
        <label className="tb-number">
          <input
            aria-label={block.label}
            type="number"
            min={block.min}
            max={block.max}
            step={block.integerOnly ? 1 : "any"}
            value={typeof value === "number" ? value : ""}
            onChange={(event) =>
              change(
                event.target.value ? event.target.valueAsNumber : undefined,
              )
            }
          />
          {block.unit && <span>{block.unit}</span>}
        </label>
      );
    case "text":
    case "transcript": {
      const shared = {
        "aria-label": block.label,
        value: String(value ?? ""),
        maxLength: block.maxLength ?? 20000,
        placeholder:
          block.placeholder ??
          (block.type === "transcript"
            ? "Type the words you hear…"
            : "Your answer…"),
        lang: block.language,
      };
      return (
        <>
          {block.type === "transcript" && (
            <small>
              {[
                block.language,
                block.notation === "ipa" ? "IPA" : "Normal spelling",
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          )}
          {block.multiline || block.type === "transcript" ? (
            <textarea
              {...shared}
              rows={3}
              onChange={(event) => change(event.target.value)}
            />
          ) : (
            <input
              {...shared}
              onChange={(event) => change(event.target.value)}
            />
          )}
        </>
      );
    }
    case "candidate_vote": {
      const vote = object(value);
      return (
        <>
          <blockquote>
            {samples?.candidateText ||
              block.candidatePrompt ||
              "No candidate annotation curated for this audio."}
          </blockquote>
          {block.candidateSource !== "example" && !samples?.candidateId && (
            <small role="note">
              Preview only: curate a candidate via /api/v1/annotation-candidates
              before assigning this block.
            </small>
          )}
          {pick(
            options.length >= 2
              ? options
              : ["AGREE", "DISAGREE", "UNSURE"].map((id) => ({
                  id,
                  label: id[0] + id.slice(1).toLowerCase(),
                })),
            vote.value,
            (id) =>
              change({
                value: id,
                ...(samples?.candidateId
                  ? { candidateId: samples.candidateId }
                  : {}),
              }),
          )}
          {block.allowCorrection &&
            vote.value === (block.correctionOnValue ?? "DISAGREE") && (
              <label className="tb-field">
                <span>Suggested correction</span>
                <textarea
                  value={String(vote.correctedText ?? "")}
                  onChange={(event) =>
                    change({ ...vote, correctedText: event.target.value })
                  }
                />
              </label>
            )}
        </>
      );
    }
    case "audio_player": {
      // The asset URL is supplied by the Task Instance or preview selector,
      // NEVER persisted inside the Task Definition.
      const url = block.stimulusSlot
        ? samples?.audio?.[block.stimulusSlot]
        : samples?.primaryUrl;
      return block.showWaveform && url ? (
        <AudioWaveformPlayer url={url} />
      ) : (
        <Recording
          slot={block.stimulusSlot || "Primary audio"}
          url={url}
          allowLocal={allowLocalAudio}
        />
      );
    }
    case "timeline_annotation":
      return (
        <AudioGroundingEditor
          block={block}
          audioUrl={samples?.primaryUrl}
          audioMeta={samples?.primaryMeta}
          value={value as GroundingAnswer | undefined}
          onChange={change}
        />
      );
    case "repeated_group": {
      const items = (value ?? []) as Item[];
      const itemName = block.itemLabel || "Item";
      return (
        <div className="tb-group">
          {items.map((item, index) => (
            <div key={item.id} className="tb-child">
              <div className="tb-between">
                <h4>
                  {itemName} {index + 1}
                </h4>
                <button
                  type="button"
                  onClick={() =>
                    change(items.filter((row) => row.id !== item.id))
                  }
                >
                  Remove item
                </button>
              </div>
              <BlockFields
                blocks={block.blocks ?? []}
                answers={item.answers}
                onChange={(answers) =>
                  change(
                    items.map((row) =>
                      row.id === item.id ? { ...row, answers } : row,
                    ),
                  )
                }
                samples={samples}
                allowLocalAudio={allowLocalAudio}
              />
            </div>
          ))}
          <button
            type="button"
            disabled={items.length >= (block.maxItems ?? Infinity)}
            onClick={() =>
              change([...items, { id: crypto.randomUUID(), answers: {} }])
            }
          >
            + Add {itemName}
          </button>
        </div>
      );
    }
    default:
      return <p>Handled in the grounding workspace.</p>;
  }
}
export default function BlockFields({
  blocks,
  answers,
  onChange,
  samples,
  allowLocalAudio,
}: Props) {
  return (
    <div className="tb-stack">
      {blocks.map(
        (block, index) =>
          visible(block, answers) &&
          // Display-only blocks deliberately don't get a fieldset or a
          // required indicator. No fake empty answer enters `answers`.
          (block.type === "section" ? (
            <header
              key={block.id}
              className={`tb-display tb-section tb-tone-${block.tone || "neutral"}`}
            >
              <h3>{block.label}</h3>
              {block.description && <p>{block.description}</p>}
            </header>
          ) : block.type === "callout" ? (
            <aside
              key={block.id}
              className={`tb-display tb-callout tb-tone-${block.tone || "info"}`}
            >
              <strong>{block.label}</strong>
              {block.description && <p>{block.description}</p>}
            </aside>
          ) : block.type === "transcript_summary" ? (
            (() => {
              // This is derived output, not a second answer in D1. The source
              // must be an earlier timeline block selected in Task Builder.
              const origin = blocks.find(
                (row) => row.id === block.sourceTimelineBlockId,
              );
              const raw = answers[block.sourceTimelineBlockId ?? ""];
              const timeline =
                raw && typeof raw === "object" && "tiers" in raw
                  ? (raw as GroundingAnswer).tiers
                  : {};
              const wordTier =
                origin?.tiers?.find((t) => t.id === "words") ??
                origin?.tiers?.find((t) => t.labelMode === "text");
              const phoneTier = origin?.tiers?.find(
                (t) => t.labelMode === "ipa",
              );
              const words = wordTier ? (timeline[wordTier.id] ?? []) : [];
              const phones = phoneTier ? (timeline[phoneTier.id] ?? []) : [];
              return (
                <aside
                  key={block.id}
                  className="tb-display tb-transcript-summary"
                >
                  <strong>{block.label}</strong>
                  {(block.summaryMode ?? "both") !== "phones" && (
                    <div>
                      <small>Current words</small>
                      <p>
                        {words.length
                          ? [...words]
                              .sort((a, b) => a.start - b.start)
                              .map((s) => s.text)
                              .join(" ")
                          : "No word intervals yet."}
                      </p>
                    </div>
                  )}
                  {(block.summaryMode ?? "both") !== "words" && (
                    <div>
                      <small>Current phones</small>
                      <p>
                        {phones.length
                          ? phoneticSummary(phones, {
                              alphabet: origin?.alphabet ?? "IPA",
                              level: origin?.transcriptionLevel ?? "broad",
                              symbols: [],
                            })
                          : "No phone intervals yet."}
                      </p>
                    </div>
                  )}
                </aside>
              );
            })()
          ) : // A grounding block is an entire research workspace, not a single
          // small question row. Give the port its full width, keeping the
          // original toolbar, plots, tiers and timing editor together.
          block.type === "timeline_annotation" ? (
            <section key={block.id} className="tb-grounding-full-block">
              <header>
                <b>{block.label}</b>
                {block.helpText && <p>{block.helpText}</p>}
              </header>
              <AnswerControl
                block={block}
                value={answers[block.id]}
                change={(value) =>
                  onChange(
                    visibleAnswers(blocks, { ...answers, [block.id]: value }),
                  )
                }
                samples={samples}
                allowLocalAudio={allowLocalAudio}
              />
            </section>
          ) : (
            <fieldset
              className={`tb-question${block.type === "boolean" && block.requiredValue === true ? " tb-confirmation" : ""}`}
              key={block.id}
            >
              <legend>
                <span>{String(index + 1).padStart(2, "0")}</span>{" "}
                {block.label || title(block.type)}{" "}
                {block.required && <em aria-label="required">*</em>}
              </legend>
              {block.helpText && <p>{block.helpText}</p>}
              <AnswerControl
                block={block}
                value={answers[block.id]}
                change={(value) =>
                  onChange(
                    visibleAnswers(blocks, { ...answers, [block.id]: value }),
                  )
                }
                samples={samples}
                allowLocalAudio={allowLocalAudio}
              />
            </fieldset>
          )),
      )}
    </div>
  );
}
