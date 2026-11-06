"use client";
/**
 * Shared question renderer. Preserve this public interface when integrating
 * Friend D's Labeller Workspace. Both the preview and real assignment should
 * call this same component; only the *parent* owns draft persistence.
 */
import AudioGroundingEditor, {AudioWaveformPlayer, type GroundingAnswer} from "@/components/audio-editor/AudioGroundingEditor";
import { phoneticSummary } from "@/lib/audio/phonetics";
import { useEffect, useId, useState } from "react";
import { editable, title, type Block } from "../task-builder/model";

// Answers live outside the block definitions. This lets the labeller page reuse the controls.
export type Answers = Record<string, unknown>;
type Item = { id: string; answers: Answers };
export type Samples = { candidateText?: string; audio?: Record<string, string>; primaryUrl?: string };
type Props = {
  blocks: Block[];
  answers: Answers;
  onChange: (answers: Answers) => void;
  samples?: Samples;
  allowLocalAudio?: boolean;
};
function object(value: unknown): Answers {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Answers) : {};
}
function visible(block: Block, answers: Answers) {
  return (
    !block.showWhen ||
    (Object.hasOwn(answers, block.showWhen.blockId) &&
      Object.is(answers[block.showWhen.blockId], block.showWhen.equals))
  );
}
// Rebuild in definition order so switching an earlier answer also clears hidden descendants.
function visibleAnswers(blocks: Block[], proposed: Answers) {
  const kept: Answers = {};
  for (const block of blocks) {
    if (visible(block, kept) && Object.hasOwn(proposed, block.id) && proposed[block.id] !== undefined)
      kept[block.id] = proposed[block.id];
  }
  return kept;
}
function answerProblem(block: Block, value: unknown): string | undefined {
  // Presentational blocks deliberately produce no annotation value.
  if (["section", "callout", "audio_player", "transcript_summary"].includes(block.type)) return;
  if (!editable(block.type)) return;
  if (value === undefined || value === "" || (typeof value === "string" && !value.trim()))
    return block.required ? "An answer is required." : undefined;
  if (block.type === "boolean" && block.requiredValue !== undefined && block.requiredValue !== value)
    return "Check the accepted Yes / No value.";
  if (block.type === "multiple_choice" && Array.isArray(value)) {
    const minimum = Math.max(block.minSelections ?? 0, block.required ? 1 : 0);
    if (value.length < minimum || value.length > (block.maxSelections ?? Infinity))
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
    if (block.integerOnly && !Number.isInteger(value)) return "Use a whole number.";
    if (
      block.type === "rating_scale" &&
      (!Number.isInteger(value) || (value - (block.min ?? 0)) % (block.step || 1) !== 0)
    )
      return "Use a marked step on the scale.";
  }
  if (block.type === "text" && typeof value === "string" && value.length > (block.maxLength ?? 20000))
    return "Shorten this answer.";
  if (block.type === "ranking") {
    const ranks = object(value);
    const slots = block.stimulusSlots ?? [];
    if (slots.some((slot) => !Number.isInteger(ranks[slot]))) return "Rank every recording.";
    if (!block.allowTies && new Set(Object.values(ranks)).size !== slots.length)
      return "Give each recording a different rank.";
  }
  if (block.type === "timeline_annotation") {
    // Preview checks the same canonical shape as the server, but only the
    // backend can be authoritative for a submitted annotation revision.
    const data = object(value);
    if (!object(data.tiers)) return "Timeline needs a 'tiers' object.";
    if (block.required && !(block.tiers??[]).some(t=>Array.isArray((data.tiers as Answers)[t.id]) &&
      ((data.tiers as Answers)[t.id] as unknown[]).length>0)) return "Label at least one time interval.";
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
          problems.push((block.itemLabel || "Item") + " " + (index + 1) + " · " + detail);
      });
    }
  }
  return problems;
}
function Recording({ slot, url, allowLocal }: { slot: string; url?: string; allowLocal?: boolean }) {
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
      {(url || localUrl) && <audio aria-label={slot} controls src={url || localUrl} />}
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
          <Recording slot={slot} url={samples?.audio?.[slot]} allowLocal={allowLocal} />
          {onRank && (
            <label className="tb-field">
              <span>Rank for {slot}</span>
              <select
                aria-label={"Rank for " + slot}
                value={String(ranks?.[slot] ?? "")}
                onChange={(event) =>
                  onRank(slot, event.target.value ? Number(event.target.value) : undefined)
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
  const options = block.options ?? [];
  // Only choice questions get these styles. Older saved questions have no
  // appearance field, so they fall back to the original bullet-point layout.
  const isChoice = block.type === "single_choice" || block.type === "multiple_choice";
  const appearance = isChoice ? (block.answerAppearance ?? "bullets") : undefined;
  const optionsClass = "tb-options" + (isChoice ? " tb-choice-options tb-choice-" + appearance : "");
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
            {appearance === "cards" && option.description && <small className="tb-choice-description">{option.description}</small>}
          </label>
        ))}
      </div>
    );
  }
  switch (block.type) {
    case "single_choice":
      return pick(options, value, change);
    case "multiple_choice": {
      // Checkboxes allow several answers; the appearance never changes the limit.
      const selected: string[] = Array.isArray(value) ? value : [];
      return (
        <div className={optionsClass}>
          {options.map((option) => (
            <label className="tb-pick" key={option.id}>
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                disabled={
                  !selected.includes(option.id) && selected.length >= (block.maxSelections ?? Infinity)
                }
                onChange={(event) =>
                  change(
                    event.target.checked
                      ? [...selected, option.id]
                      : selected.filter((id) => id !== option.id),
                  )
                }
              />
              <span>{option.label}</span>
              {appearance === "cards" && option.description && <small className="tb-choice-description">{option.description}</small>}
            </label>
          ))}
        </div>
      );
    }
    case "boolean":
      return pick(
        [
          { id: "true", label: "Yes" },
          { id: "false", label: "No" },
        ],
        String(value),
        (id) => change(id === "true"),
      );
    case "rating_scale": {
      const { min = 1, max = 5, step = 1 } = block;
      const count = Math.floor((max - min) / step) + 1;
      if (Number.isInteger(count) && count > 0 && count <= 12) {
        const choices = Array.from({ length: count }, (_, position) => String(min + position * step));
        return (
          <>
            {pick(
              choices.map((id) => ({ id, label: id })),
              String(value),
              (id) => change(Number(id)),
            )}
            <small>{[block.minLabel, block.maxLabel].filter(Boolean).join(" — ")}</small>
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
          onChange={(event) => change(event.target.value ? event.target.valueAsNumber : undefined)}
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
            onChange={(event) => change(event.target.value ? event.target.valueAsNumber : undefined)}
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
          (block.type === "transcript" ? "Type the words you hear…" : "Your answer…"),
        lang: block.language,
      };
      return (
        <>
          {block.type === "transcript" && (
            <small>
              {[block.language, block.notation === "ipa" ? "IPA" : "Normal spelling"]
                .filter(Boolean)
                .join(" · ")}
            </small>
          )}
          {block.multiline || block.type === "transcript" ? (
            <textarea {...shared} rows={3} onChange={(event) => change(event.target.value)} />
          ) : (
            <input {...shared} onChange={(event) => change(event.target.value)} />
          )}
        </>
      );
    }
    case "candidate_vote": {
      const vote = object(value);
      return (
        <>
          <blockquote>
            {samples?.candidateText || "Example suggestion · A bird calls in this clip."}
          </blockquote>
          {pick(
            ["AGREE", "DISAGREE", "UNSURE"].map((id) => ({
              id,
              label: id[0] + id.slice(1).toLowerCase(),
            })),
            vote.value,
            (id) => change({ value: id }),
          )}
          {block.allowCorrection && vote.value === "DISAGREE" && (
            <label className="tb-field">
              <span>Suggested correction</span>
              <textarea
                value={String(vote.correctedText ?? "")}
                onChange={(event) => change({ ...vote, correctedText: event.target.value })}
              />
            </label>
          )}
        </>
      );
    }
    case "audio_player": {
      // The asset URL is supplied by the Task Instance or preview selector,
      // NEVER persisted inside the Task Definition.
      const url=block.stimulusSlot ? samples?.audio?.[block.stimulusSlot] : samples?.primaryUrl;
      return block.showWaveform && url ? <AudioWaveformPlayer url={url}/> :
        <Recording slot={block.stimulusSlot||"Primary audio"} url={url} allowLocal={allowLocalAudio}/>;
    }
    case "timeline_annotation":
      return <AudioGroundingEditor block={block} audioUrl={samples?.primaryUrl}
        value={value as GroundingAnswer | undefined} onChange={change}/>;
    case "audio_comparison":
      return (
        <>
          <Recordings block={block} samples={samples} allowLocal={allowLocalAudio} />
          {pick(options, value, change)}
        </>
      );
    case "ranking": {
      const ranks = object(value);
      return (
        <>
          <small>
            Rank 1 is your first choice. {block.allowTies ? "Ties are allowed." : "Use each rank once."}
          </small>
          <Recordings
            block={block}
            samples={samples}
            allowLocal={allowLocalAudio}
            ranks={ranks}
            onRank={(slot, rank) => {
              const updated = { ...ranks };
              if (rank === undefined) delete updated[slot];
              else updated[slot] = rank;
              change(Object.keys(updated).length ? updated : undefined);
            }}
          />
        </>
      );
    }
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
                <button type="button" onClick={() => change(items.filter((row) => row.id !== item.id))}>
                  Remove item
                </button>
              </div>
              <BlockFields
                blocks={block.blocks ?? []}
                answers={item.answers}
                onChange={(answers) =>
                  change(items.map((row) => (row.id === item.id ? { ...row, answers } : row)))
                }
                samples={samples}
                allowLocalAudio={allowLocalAudio}
              />
            </div>
          ))}
          <button
            type="button"
            disabled={items.length >= (block.maxItems ?? Infinity)}
            onClick={() => change([...items, { id: crypto.randomUUID(), answers: {} }])}
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
export default function BlockFields({ blocks, answers, onChange, samples, allowLocalAudio }: Props) {
  return (
    <div className="tb-stack">
      {blocks.map(
        (block, index) =>
          visible(block, answers) && (
            // Display-only blocks deliberately don't get a fieldset or a
            // required indicator. No fake empty answer enters `answers`.
            block.type === "section" ? <header key={block.id} className={`tb-display tb-section tb-tone-${block.tone||"neutral"}`}>
              <h3>{block.label}</h3>{block.description&&<p>{block.description}</p>}
            </header> :
            block.type === "callout" ? <aside key={block.id} className={`tb-display tb-callout tb-tone-${block.tone||"info"}`}>
              <strong>{block.label}</strong>{block.description&&<p>{block.description}</p>}
            </aside> :
            block.type === "transcript_summary" ? (() => {
              // This is derived output, not a second answer in D1. The source
              // must be an earlier timeline block selected in Task Builder.
              const origin = blocks.find(row=>row.id===block.sourceTimelineBlockId);
              const raw = answers[block.sourceTimelineBlockId??""];
              const timeline = raw && typeof raw === "object" && "tiers" in raw ?
                (raw as GroundingAnswer).tiers : {};
              const wordTier=origin?.tiers?.find(t=>t.id==="words")??origin?.tiers?.find(t=>t.labelMode==="text");
              const phoneTier=origin?.tiers?.find(t=>t.labelMode==="ipa");
              const words=wordTier?timeline[wordTier.id]??[]:[];
              const phones=phoneTier?timeline[phoneTier.id]??[]:[];
              return <aside key={block.id} className="tb-display tb-transcript-summary">
                <strong>{block.label}</strong>
                {(block.summaryMode??"both")!=="phones" && <div><small>Current words</small><p>{words.length?[...words].sort((a,b)=>a.start-b.start).map(s=>s.text).join(" "):"No word intervals yet."}</p></div>}
                {(block.summaryMode??"both")!=="words" && <div><small>Current phones</small><p>{phones.length?phoneticSummary(phones,{alphabet:origin?.alphabet??"IPA",level:origin?.transcriptionLevel??"broad",symbols:[]}):"No phone intervals yet."}</p></div>}
              </aside>;
            })() :
            <fieldset className={`tb-question${block.type === "boolean" && block.requiredValue === true?" tb-confirmation":""}${block.type === "timeline_annotation"?" tb-timeline-question":""}`} key={block.id}>
              <legend>
                <span>{String(index + 1).padStart(2, "0")}</span> {block.label || title(block.type)}{" "}
                {block.required && <em aria-label="required">*</em>}
              </legend>
              {block.helpText && <p>{block.helpText}</p>}
              <AnswerControl
                block={block}
                value={answers[block.id]}
                change={(value) => onChange(visibleAnswers(blocks, { ...answers, [block.id]: value }))}
                samples={samples}
                allowLocalAudio={allowLocalAudio}
              />
            </fieldset>
          ),
      )}
    </div>
  );
}
