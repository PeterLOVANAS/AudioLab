import ChoiceJsonImport from "./ChoiceJsonImport";
import BlockSourceSettings from "./BlockSourceSettings";
import type { SourceFieldDescriptor } from "@/lib/contracts/source-fields";
import {
  cloneElement,
  useState,
  type DragEvent,
  type ReactElement,
} from "react";
import TimelineTierSettings from "./TimelineTierSettings";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import type { AnnotationScope, BlockCondition } from "@/lib/contracts/tasks";
import {
  canSubmit,
  catalog,
  conditionSources,
  editable,
  hasChoiceOptions,
  kinds,
  newBlock,
  title,
  type Block,
  type AnswerAppearance,
  type EditableKind,
} from "./model";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ "aria-label"?: string }>;
}) {
  return (
    <label className="tb-field">
      <span>{label}</span>
      {cloneElement(children, { "aria-label": label })}
    </label>
  );
}
function Numeric({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: number;
  onChange: (value?: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        step="any"
        value={value ?? ""}
        onChange={(event) =>
          onChange(
            event.target.value === "" ? undefined : event.target.valueAsNumber,
          )
        }
      />
    </Field>
  );
}
function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="tb-check">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
function Condition({
  block,
  prior,
  change,
}: {
  block: Block;
  prior: Block[];
  change: (value?: BlockCondition) => void;
}) {
  const sources = conditionSources(prior);
  const rule = block.showWhen;
  const source = sources.find((item) => item.id === rule?.blockId);
  function choose(id: string) {
    const next = sources.find((item) => item.id === id);
    if (!next) return change();
    let equals: BlockCondition["equals"] = "";
    if (next.type === "boolean") equals = true;
    if (next.type === "single_choice") equals = next.options?.[0]?.id ?? "";
    if (next.type === "number" || next.type === "rating_scale")
      equals = next.min ?? 0;
    change({ blockId: next.id, equals });
  }
  return (
    <div className="tb-grid">
      <Field label="Show this question">
        <select
          value={rule?.blockId ?? ""}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="">Always</option>
          {rule && !source && (
            <option value={rule.blockId}>Missing earlier question</option>
          )}
          {sources.map((item) => (
            <option key={item.id} value={item.id}>
              When · {item.label}
            </option>
          ))}
        </select>
      </Field>
      {source && rule && (
        <Field label="If its answer equals">
          {source.type === "boolean" ? (
            <select
              value={String(rule.equals)}
              onChange={(event) =>
                change({ ...rule, equals: event.target.value === "true" })
              }
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : source.type === "single_choice" ? (
            <select
              value={String(rule.equals)}
              onChange={(event) =>
                change({ ...rule, equals: event.target.value })
              }
            >
              {!source.options?.some((option) => option.id === rule.equals) && (
                <option value="">Choose an option</option>
              )}
              {source.options?.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={source.type === "text" ? "text" : "number"}
              value={String(rule.equals)}
              onChange={(event) =>
                change({
                  ...rule,
                  equals:
                    source.type === "text" || !event.target.value
                      ? event.target.value
                      : event.target.valueAsNumber,
                })
              }
            />
          )}
        </Field>
      )}
    </div>
  );
}
function BlockSettings({
  block,
  onChange,
  prior,
  depth,
  sourceFields,
  sourceValues,
}: {
  sourceFields?: SourceFieldDescriptor[];
  sourceValues?: Array<{ field: SourceFieldDescriptor; value: unknown }>;
  block: Block;
  onChange: (block: Block) => void;
  prior: Block[];
  depth: number;
}) {
  const set = (changes: Partial<Block>) => onChange({ ...block, ...changes });
  const options = block.options ?? [];
  const slots = block.stimulusSlots ?? [];
  return (
    <div className="tb-settings">
      {/* Information blocks do not write answer keys. The same setting is
          validated by the server, preventing confusing required markers. */}
      {!["section", "callout", "audio_player"].includes(block.type) && (
        <Switch
          label="Answer required"
          checked={block.required}
          onChange={(required) => set({ required })}
        />
      )}

      <BlockSourceSettings
        block={block}
        fields={sourceFields}
        values={sourceValues}
        onChange={onChange}
      />
      {(block.type === "single_choice" || block.type === "multiple_choice") && (
        <div className="tb-grid">
          <Field label="Question type">
            <select
              value={block.type}
              onChange={(event) =>
                set({
                  type: event.target.value as
                    "single_choice" | "multiple_choice",
                })
              }
            >
              <option value="single_choice">Single choice</option>
              <option value="multiple_choice">Multiple choice</option>
            </select>
          </Field>
          <Field label="Answer appearance">
            <select
              value={block.answerAppearance ?? "bullets"}
              onChange={(event) =>
                set({
                  answerAppearance: event.target.value as AnswerAppearance,
                })
              }
            >
              <option value="cards">Large cards</option>
              <option value="compact">Compact buttons</option>
              <option value="bullets">Bullet points</option>
              <option value="exam">Exam list (numbered, many choices)</option>
              {block.type === "multiple_choice" && (
                <option value="checkbox-grid">Checkboxes — two columns</option>
              )}
            </select>
          </Field>
        </div>
      )}
      <Field label="Question label">
        <input
          maxLength={300}
          value={block.label}
          onChange={(event) => set({ label: event.target.value })}
        />
      </Field>
      <Field label="Help text">
        <input
          value={block.helpText ?? ""}
          placeholder="Optional hint for the labeller"
          onChange={(event) => set({ helpText: event.target.value })}
        />
      </Field>
      {/* Every question in a batch shares ONE configuration and produces one
          answer for each recording. Audio comparison groups recordings into
          sets of `comparisonSize` instead of showing NUM_BATCH separate pairs. */}
      {[
        "single_choice",
        "multiple_choice",
        "boolean",
        "number",
        "text",
        "rating_scale",
        "audio_comparison",
        "audio_player",
        "timeline_annotation",
      ].includes(block.type) && (
        <div className="tb-field">
          <Numeric
            label="NUM_BATCH — recordings in one task (1–24)"
            value={block.numBatch ?? 1}
            onChange={(n) =>
              set({ numBatch: n === undefined ? 1 : Math.round(n) })
            }
          />
          <small>
            One answer panel per audio; comparison panels = NUM_BATCH ÷
            recordings per comparison.
          </small>
        </div>
      )}

      {["section", "callout"].includes(block.type) && (
        <>
          <Field label="Description / body text">
            <textarea
              rows={3}
              maxLength={10000}
              value={block.description ?? ""}
              placeholder="Explain the next step, protocol or confirmation."
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          <Field label="Panel color">
            <select
              value={block.tone ?? "neutral"}
              onChange={(e) => set({ tone: e.target.value as Block["tone"] })}
            >
              <option value="neutral">Neutral</option>
              <option value="success">Green — confirmed</option>
              <option value="warning">Amber — caution</option>
              <option value="info">Blue — information</option>
            </select>
          </Field>
          <p className="tb-muted">
            This is a display-only block. Add a conditional Boolean block below
            it if the labeller must confirm something.
          </p>
        </>
      )}
      {block.type === "audio_player" && (
        <>
          <Field label="Recording slot (optional)">
            <input
              value={block.stimulusSlot ?? ""}
              placeholder="Leave blank for primary task recording"
              onChange={(e) => set({ stimulusSlot: e.target.value })}
            />
          </Field>
          <Switch
            label="Show waveform in the audio editor"
            checked={block.showWaveform}
            onChange={(showWaveform) => set({ showWaveform })}
          />
          <p className="tb-muted">
            Audio is bound on a Task Instance. The reusable definition must not
            store real asset URLs.
          </p>
        </>
      )}
      {block.type === "timeline_annotation" && (
        <TimelineTierSettings block={block} onChange={onChange} />
      )}
      {block.type === "transcript_summary" && (
        <>
          <Field label="Grounding block to summarize">
            <select
              value={block.sourceTimelineBlockId ?? ""}
              onChange={(e) => set({ sourceTimelineBlockId: e.target.value })}
            >
              <option value="">Choose an earlier grounding block</option>
              {prior
                .filter((b) => b.type === "timeline_annotation")
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Show which summaries">
            <select
              value={block.summaryMode ?? "both"}
              onChange={(e) =>
                set({ summaryMode: e.target.value as Block["summaryMode"] })
              }
            >
              <option value="both">Words and phones</option>
              <option value="words">Words only</option>
              <option value="phones">Phones only</option>
            </select>
          </Field>
          <p className="tb-muted">
            This panel updates instantly when the labeller edits timeline
            intervals. It does not create its own answer.
          </p>
        </>
      )}
      {hasChoiceOptions(block.type) &&
        !(
          block.type === "candidate_vote" && block.candidateSource === "set"
        ) && (
          <div className="tb-field">
            <span>Answer choices</span>
            {["single_choice", "multiple_choice"].includes(block.type) && (
              <>
                <ChoiceJsonImport
                  onImport={(next) => {
                    const sourceBindings = { ...block.sourceBindings };
                    delete sourceBindings.options;
                    const optionFollowUps = Object.fromEntries(
                      Object.entries(block.optionFollowUps ?? {}).filter(
                        ([id]) => next.some((option) => option.id === id),
                      ),
                    );
                    set({ options: next, sourceBindings, optionFollowUps });
                  }}
                />
                <Switch
                  label="Allow a written Custom answer"
                  checked={block.allowCustom}
                  onChange={(allowCustom) => set({ allowCustom })}
                />
              </>
            )}

            {options.map((option, index) => (
              <div key={option.id || index} className="tb-option-edit">
                <span>{index + 1}</span>
                <div className="tb-choice-edit-fields">
                  {/* Changing the label or description keeps the answer's ID intact. */}
                  <input
                    aria-label={"Choice " + (index + 1)}
                    value={option.label}
                    onChange={(event) =>
                      set({
                        options: options.map((item, position) =>
                          position === index
                            ? { ...item, label: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                  {/* Hide this editor for other styles, but preserve any description. */}
                  {(block.type === "single_choice" ||
                    block.type === "multiple_choice") &&
                    block.answerAppearance === "cards" && (
                      <input
                        aria-label={"Description for choice " + (index + 1)}
                        placeholder="Optional description beneath this answer"
                        value={option.description ?? ""}
                        onChange={(event) =>
                          set({
                            options: options.map((item, position) =>
                              position === index
                                ? { ...item, description: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    )}
                </div>
                {/* Option-specific nested controls. These do NOT enter the
                  top-level Task Definition block array; they are stored under
                  optionFollowUps[option.id] and rendered under the selected
                  choice by the SAME shared Labeller block component. */}
                {["single_choice", "multiple_choice"].includes(block.type) && (
                  <details className="tb-followup-settings">
                    <summary>
                      Conditional follow-ups for this choice (
                      {block.optionFollowUps?.[option.id]?.length ?? 0})
                    </summary>
                    {(block.optionFollowUps?.[option.id] ?? []).map((child) => (
                      <div key={child.id} className="tb-inline-config">
                        <select
                          value={child.type}
                          aria-label="Follow-up type"
                          onChange={(e) =>
                            set({
                              optionFollowUps: {
                                ...block.optionFollowUps,
                                [option.id]: (
                                  block.optionFollowUps?.[option.id] ?? []
                                ).map((c) =>
                                  c.id === child.id
                                    ? {
                                        ...c,
                                        type: e.target.value as typeof c.type,
                                        required: e.target.value !== "callout",
                                      }
                                    : c,
                                ),
                              },
                            })
                          }
                        >
                          <option value="boolean">Yes / No checkbox</option>
                          <option value="callout">Information panel</option>
                          <option value="text">Text</option>
                          <option value="number">Number</option>
                        </select>
                        <input
                          aria-label="Follow-up label"
                          value={child.label}
                          onChange={(e) =>
                            set({
                              optionFollowUps: {
                                ...block.optionFollowUps,
                                [option.id]: (
                                  block.optionFollowUps?.[option.id] ?? []
                                ).map((c) =>
                                  c.id === child.id
                                    ? { ...c, label: e.target.value }
                                    : c,
                                ),
                              },
                            })
                          }
                        />
                        {child.type === "callout" && (
                          <textarea
                            aria-label="Panel content"
                            value={child.description ?? ""}
                            onChange={(e) =>
                              set({
                                optionFollowUps: {
                                  ...block.optionFollowUps,
                                  [option.id]: (
                                    block.optionFollowUps?.[option.id] ?? []
                                  ).map((c) =>
                                    c.id === child.id
                                      ? { ...c, description: e.target.value }
                                      : c,
                                  ),
                                },
                              })
                            }
                          />
                        )}
                        {child.type === "boolean" && (
                          <label className="tb-check">
                            <input
                              type="checkbox"
                              checked={child.requiredValue === true}
                              onChange={(e) =>
                                set({
                                  optionFollowUps: {
                                    ...block.optionFollowUps,
                                    [option.id]: (
                                      block.optionFollowUps?.[option.id] ?? []
                                    ).map((c) =>
                                      c.id === child.id
                                        ? {
                                            ...c,
                                            requiredValue: e.target.checked
                                              ? true
                                              : undefined,
                                          }
                                        : c,
                                    ),
                                  },
                                })
                              }
                            />
                            Must be checked
                          </label>
                        )}
                        {child.type !== "callout" && (
                          <label className="tb-check">
                            <input
                              type="checkbox"
                              checked={child.required}
                              onChange={(e) =>
                                set({
                                  optionFollowUps: {
                                    ...block.optionFollowUps,
                                    [option.id]: (
                                      block.optionFollowUps?.[option.id] ?? []
                                    ).map((c) =>
                                      c.id === child.id
                                        ? { ...c, required: e.target.checked }
                                        : c,
                                    ),
                                  },
                                })
                              }
                            />
                            Required
                          </label>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            set({
                              optionFollowUps: {
                                ...block.optionFollowUps,
                                [option.id]: (
                                  block.optionFollowUps?.[option.id] ?? []
                                ).filter((c) => c.id !== child.id),
                              },
                            })
                          }
                        >
                          Delete follow-up
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="tb-link"
                      onClick={() =>
                        set({
                          optionFollowUps: {
                            ...block.optionFollowUps,
                            [option.id]: [
                              ...(block.optionFollowUps?.[option.id] ?? []),
                              {
                                id: crypto.randomUUID(),
                                type: "boolean",
                                label: "I confirm",
                                required: true,
                                requiredValue: true,
                              },
                            ],
                          },
                        })
                      }
                    >
                      + Add inline sub-block
                    </button>
                  </details>
                )}
                <button
                  type="button"
                  aria-label={"Remove choice " + (index + 1)}
                  onClick={() =>
                    set({
                      options: options.filter(
                        (_, position) => position !== index,
                      ),
                    })
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="tb-link"
              onClick={() =>
                set({
                  options: [...options, { id: crypto.randomUUID(), label: "" }],
                })
              }
            >
              + Add choice
            </button>
          </div>
        )}
      {block.type === "multiple_choice" && (
        <div className="tb-grid">
          <Numeric
            label="Minimum selections"
            value={block.minSelections}
            onChange={(minSelections) => set({ minSelections })}
          />
          <Numeric
            label="Maximum selections"
            value={block.maxSelections}
            onChange={(maxSelections) => set({ maxSelections })}
          />
        </div>
      )}
      {block.type === "boolean" && (
        <Field label="Accepted answer">
          <select
            value={String(block.requiredValue ?? "")}
            onChange={(event) =>
              set({
                requiredValue:
                  event.target.value === ""
                    ? undefined
                    : event.target.value === "true",
              })
            }
          >
            <option value="">Either answer</option>
            <option value="true">Must be Yes</option>
            <option value="false">Must be No</option>
          </select>
        </Field>
      )}
      {(block.type === "number" || block.type === "rating_scale") && (
        <div className="tb-grid">
          <Numeric
            label="Minimum"
            value={block.min}
            onChange={(min) => set({ min })}
          />
          <Numeric
            label="Maximum"
            value={block.max}
            onChange={(max) => set({ max })}
          />
        </div>
      )}
      {block.type === "number" && (
        <>
          <Field label="Unit">
            <input
              value={block.unit ?? ""}
              placeholder="e.g. speakers"
              onChange={(event) => set({ unit: event.target.value })}
            />
          </Field>
          <Switch
            label="Whole numbers only"
            checked={block.integerOnly}
            onChange={(integerOnly) => set({ integerOnly })}
          />
        </>
      )}
      {block.type === "rating_scale" && (
        <>
          <Field label="Rating appearance">
            <select
              value={block.ratingAppearance ?? "buttons"}
              onChange={(e) =>
                set({
                  ratingAppearance: e.target.value as Block["ratingAppearance"],
                })
              }
            >
              <option value="slider">Slider line</option>
              <option value="buttons">Discrete marked buttons</option>
            </select>
          </Field>
          <Numeric
            label="Step"
            value={block.step}
            onChange={(step) => set({ step })}
          />
          <div className="tb-grid">
            {(["minLabel", "maxLabel"] as const).map((key, index) => (
              <Field
                key={key}
                label={index ? "High end label" : "Low end label"}
              >
                <input
                  value={block[key] ?? ""}
                  onChange={(event) => set({ [key]: event.target.value })}
                />
              </Field>
            ))}
          </div>
        </>
      )}
      {block.type === "text" && (
        <>
          <Switch
            label="Multiple lines"
            checked={block.multiline}
            onChange={(multiline) => set({ multiline })}
          />
          <Field label="Placeholder">
            <input
              value={block.placeholder ?? ""}
              onChange={(event) => set({ placeholder: event.target.value })}
            />
          </Field>
          <Numeric
            label="Character limit"
            value={block.maxLength}
            onChange={(maxLength) => set({ maxLength })}
          />
        </>
      )}
      {block.type === "transcript" && (
        <div className="tb-grid">
          <Field label="Language">
            <input
              value={block.language ?? ""}
              placeholder="e.g. th or en"
              onChange={(event) => set({ language: event.target.value })}
            />
          </Field>
          <Field label="Notation">
            <select
              value={block.notation ?? "orthographic"}
              onChange={(event) =>
                set({ notation: event.target.value as Block["notation"] })
              }
            >
              <option value="orthographic">Normal spelling</option>
              <option value="ipa">IPA phonetic symbols</option>
            </select>
          </Field>
        </div>
      )}
      {block.type === "candidate_vote" && (
        <>
          <Field label="Candidate annotation source">
            <select
              value={block.candidateSource ?? "curated"}
              onChange={(e) =>
                set({
                  candidateSource: e.target.value as Block["candidateSource"],
                  ...(e.target.value === "set"
                    ? {
                        options: undefined,
                        correctionOnValue: undefined,
                        allowCorrection: false,
                      }
                    : !block.options
                      ? {
                          options: ["AGREE", "DISAGREE", "UNSURE"].map(
                            (id) => ({ id, label: id }),
                          ),
                        }
                      : {}),
                })
              }
            >
              <option value="set">
                Candidate set — stored annotations and submissions
              </option>
              <option value="curated">
                Task Instance — curated candidate from database
              </option>
              <option value="example">Example text (preview only)</option>
            </select>
          </Field>
          {block.candidateSource === "set" && (
            <>
              <Field label="Minimum submitted votes">
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={block.minimumVotes ?? ""}
                  placeholder="Task policy default"
                  onChange={(event) =>
                    set({
                      minimumVotes:
                        event.target.value === ""
                          ? undefined
                          : event.target.valueAsNumber,
                    })
                  }
                />
              </Field>
              <Switch
                label="Allow voting on own submitted work"
                checked={block.allowSelfVote}
                onChange={(allowSelfVote) => set({ allowSelfVote })}
              />
              <fieldset>
                <legend>Permitted candidate sources</legend>
                {(
                  [
                    ["dataset_annotation", "Imported early annotations"],
                    ["submission", "Earlier labeller submissions"],
                    ["curated", "Curated records"],
                  ] as const
                ).map(([kind, label]) => {
                  const origins = block.candidateOrigins ?? [
                    "dataset_annotation",
                    "submission",
                    "curated",
                  ];
                  return (
                    <label className="tb-check" key={kind}>
                      <input
                        type="checkbox"
                        checked={origins.includes(kind)}
                        disabled={
                          origins.length === 1 && origins.includes(kind)
                        }
                        onChange={(event) =>
                          set({
                            candidateOrigins: event.target.checked
                              ? [...origins, kind]
                              : origins.filter((value) => value !== kind),
                          })
                        }
                      />
                      {label}
                    </label>
                  );
                })}
              </fieldset>
              <p className="tb-muted">
                Prepare each job's real candidate set in Team & Assignments. A
                strict majority is required after the minimum; ties stay
                unresolved.
              </p>
            </>
          )}
          <p className="tb-muted">
            Source-record REFERENCE ANSWERS remain private. Candidate votes use
            separately curated candidate annotations.
          </p>
          {block.candidateSource !== "set" && (
            <>
              <Field label="Candidate/question text">
                <textarea
                  rows={2}
                  value={block.candidatePrompt ?? ""}
                  placeholder="Does this suggested annotation match the recording?"
                  onChange={(e) => set({ candidatePrompt: e.target.value })}
                />
              </Field>
              <Switch
                label="Allow suggested correction"
                checked={block.allowCorrection}
                onChange={(allowCorrection) => set({ allowCorrection })}
              />
              {block.allowCorrection && (
                <Field label="Ask for correction when option is">
                  <select
                    value={block.correctionOnValue ?? "DISAGREE"}
                    onChange={(e) => set({ correctionOnValue: e.target.value })}
                  >
                    {(block.options ?? []).map((o) => (
                      <option value={o.id} key={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <p className="tb-muted">
                Edit each vote's displayed label below. Stable option IDs are
                saved to annotation revisions.
              </p>
            </>
          )}
        </>
      )}
      {(block.type === "ranking" || block.type === "audio_comparison") && (
        <>
          {block.type === "ranking" && (
            <div className="tb-grid">
              <Field label="Rank what?">
                <select
                  value={block.rankingMode ?? "audios"}
                  onChange={(e) =>
                    set({ rankingMode: e.target.value as Block["rankingMode"] })
                  }
                >
                  <option value="audios">Different audio recordings</option>
                  <option value="labels">
                    Attributes / labels of one recording
                  </option>
                </select>
              </Field>
              <Field label="Only one ranking interaction">
                <select
                  value={block.rankingInput ?? "drag"}
                  onChange={(e) =>
                    set({
                      rankingInput: e.target.value as Block["rankingInput"],
                    })
                  }
                >
                  <option value="drag">Drag to reorder</option>
                  <option value="arrows">Move up/down buttons</option>
                  <option value="comma">
                    Comma-separated position numbers
                  </option>
                </select>
              </Field>
            </div>
          )}
          {block.type === "ranking" && block.rankingMode === "labels" && (
            <div className="tb-field">
              <span>Labels/attributes to rank</span>
              {(block.rankLabels ?? []).map((o, i) => (
                <div className="tb-option-edit" key={o.id}>
                  <span>{i + 1}</span>
                  <input
                    aria-label={`Ranking label ${i + 1}`}
                    value={o.label}
                    onChange={(e) =>
                      set({
                        rankLabels: (block.rankLabels ?? []).map((a) =>
                          a.id === o.id ? { ...a, label: e.target.value } : a,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      set({
                        rankLabels: (block.rankLabels ?? []).filter(
                          (a) => a.id !== o.id,
                        ),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="tb-link"
                onClick={() =>
                  set({
                    rankLabels: [
                      ...(block.rankLabels ?? []),
                      { id: crypto.randomUUID(), label: "" },
                    ],
                  })
                }
              >
                + Add attribute
              </button>
            </div>
          )}
          {block.type === "audio_comparison" && (
            <div className="tb-grid">
              <Numeric
                label="Recordings in each comparison (2–4)"
                value={block.comparisonSize ?? 2}
                onChange={(n) => set({ comparisonSize: n ?? 2 })}
              />
              <Field label="Choice button size">
                <select
                  value={block.comparisonButtonSize ?? "md"}
                  onChange={(e) =>
                    set({
                      comparisonButtonSize: e.target
                        .value as Block["comparisonButtonSize"],
                    })
                  }
                >
                  <option value="sm">Small</option>
                  <option value="md">Medium</option>
                  <option value="lg">Large</option>
                </select>
              </Field>
              <Field label="Choice position">
                <select
                  value={block.comparisonButtonPosition ?? "inside"}
                  onChange={(e) =>
                    set({
                      comparisonButtonPosition: e.target
                        .value as Block["comparisonButtonPosition"],
                    })
                  }
                >
                  <option value="inside">Inside comparison card</option>
                  <option value="outside">Below comparison card</option>
                </select>
              </Field>
            </div>
          )}
          {(block.type !== "ranking" || block.rankingMode !== "labels") && (
            <div className="tb-field">
              <span>Recording slot names</span>
              {slots.map((slot, index) => (
                <div key={index} className="tb-option-edit">
                  <span>{index + 1}</span>
                  <input
                    aria-label={"Slot " + (index + 1)}
                    value={slot}
                    onChange={(event) =>
                      set({
                        stimulusSlots: slots.map((name, position) =>
                          position === index ? event.target.value : name,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    aria-label={"Remove slot " + (index + 1)}
                    onClick={() =>
                      set({
                        stimulusSlots: slots.filter(
                          (_, position) => position !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="tb-link"
                onClick={() => set({ stimulusSlots: [...slots, ""] })}
              >
                + Add recording slot
              </button>
            </div>
          )}
          <p className="tb-muted">
            The new ranking/comparison renderer uses the displayed audio order.
            Tie ranking and randomized presentation are disabled until their
            answer contracts are defined.
          </p>
        </>
      )}
      {block.type === "repeated_group" && depth < 3 && (
        <>
          <Field label="Repeated item name">
            <input
              value={block.itemLabel ?? ""}
              onChange={(event) => set({ itemLabel: event.target.value })}
            />
          </Field>
          <div className="tb-grid">
            <Numeric
              label="Minimum items"
              value={block.minItems}
              onChange={(minItems) => set({ minItems })}
            />
            <Numeric
              label="Maximum items"
              value={block.maxItems}
              onChange={(maxItems) => set({ maxItems })}
            />
          </div>
          <div className="tb-child">
            <h4>Questions inside each item</h4>
            <BlockEditor
              blocks={block.blocks ?? []}
              onChange={(blocks) => set({ blocks })}
              sourceFields={sourceFields}
              sourceValues={sourceValues}
              depth={depth + 1}
            />
          </div>
        </>
      )}
      <details className="tb-detail">
        <summary>Scope and visibility</summary>
        <div className="tb-settings">
          <Field label="Applies to">
            <select
              value={block.scope ?? "clip"}
              onChange={(event) =>
                set({ scope: event.target.value as AnnotationScope })
              }
            >
              {[
                "clip",
                "interval",
                "speaker",
                "event",
                "audio_pair",
                "candidate",
              ].map((scope) => (
                <option key={scope} value={scope}>
                  {scope.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Condition
            block={block}
            prior={prior}
            change={(showWhen) => set({ showWhen })}
          />
        </div>
      </details>
    </div>
  );
}
export default function BlockEditor({
  blocks,
  onChange,
  depth = 0,
  sourceFields,
  sourceValues,
}: {
  sourceFields?: SourceFieldDescriptor[];
  sourceValues?: Array<{ field: SourceFieldDescriptor; value: unknown }>;
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  depth?: number;
}) {
  /**
   * Browser drag-and-drop changes ONLY the order of the block array; IDs,
   * answers and condition references remain intact. We purposely do not
   * assign new IDs or rebuild blocks on reorder, because doing so would
   * invalidate existing draft answers and published definitions.
   */
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  function reorder(targetId: string) {
    if (!draggedId || targetId === draggedId) return;
    const source = blocks.findIndex((b) => b.id === draggedId);
    const target = blocks.findIndex((b) => b.id === targetId);
    if (source < 0 || target < 0) return;
    const next = [...blocks];
    const [moving] = next.splice(source, 1);
    next.splice(target, 0, moving);
    onChange(next);
  }
  function endDrag() {
    setDraggedId(null);
    setDropBeforeId(null);
  }
  return (
    <div className="tb-list">
      {blocks.map((block, index) => (
        <section
          className={
            "tb-block" + (dropBeforeId === block.id ? " tb-drop-before" : "")
          }
          data-block={block.id}
          key={block.id}
          onDragOver={(event: DragEvent<HTMLElement>) => {
            if (!draggedId || draggedId === block.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropBeforeId(block.id);
          }}
          onDrop={(event) => {
            event.preventDefault();
            reorder(block.id);
            endDrag();
          }}
        >
          <details>
            <summary>
              <span className="tb-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="tb-block-title">
                <b>{block.label || "Untitled question"}</b>
                <small>
                  {title(block.type)}
                  {block.required ? " · Required" : ""}
                </small>
              </span>
              <span className="tb-caret" aria-hidden="true">
                ⌄
              </span>
            </summary>
            {editable(block.type) ? (
              <BlockSettings
                sourceFields={sourceFields}
                sourceValues={sourceValues}
                block={block}
                prior={blocks.slice(0, index)}
                depth={depth}
                onChange={(changed) =>
                  onChange(
                    blocks.map((item) =>
                      item.id === block.id ? changed : item,
                    ),
                  )
                }
              />
            ) : (
              <p className="tb-inset">
                Managed by the grounding workspace. Its settings are preserved
                when you save.
              </p>
            )}
          </details>
          <div className="tb-block-tools">
            <span>{canSubmit(block.type) ? "Supported" : "Preview only"}</span>
            {/* A dedicated drag handle avoids swallowing clicks on the
                expandable card or dragging while changing an input. */}
            <button
              type="button"
              className="tb-drag-handle"
              draggable
              aria-label={`Drag ${block.label} to reorder; Alt+Arrow keys also work`}
              title="Drag this handle to reorder blocks"
              onDragStart={(event) => {
                setDraggedId(block.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", block.id);
              }}
              onDragEnd={endDrag}
              onKeyDown={(event) => {
                if (
                  !event.altKey ||
                  !["ArrowUp", "ArrowDown"].includes(event.key)
                )
                  return;
                event.preventDefault();
                const next = [...blocks];
                const dest = index + (event.key === "ArrowUp" ? -1 : 1);
                if (dest < 0 || dest >= blocks.length) return;
                [next[index], next[dest]] = [next[dest], next[index]];
                onChange(next);
              }}
            >
              <GripVertical size={18} />
            </button>
            {editable(block.type) && (
              <button
                type="button"
                aria-label={"Remove " + block.label}
                onClick={() =>
                  onChange(blocks.filter((item) => item.id !== block.id))
                }
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </section>
      ))}
      {draggedId && (
        <div
          className="tb-drop-end"
          role="status"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            event.preventDefault();
            const next = blocks.filter((b) => b.id !== draggedId);
            const moving = blocks.find((b) => b.id === draggedId);
            if (moving) onChange([...next, moving]);
            endDrag();
          }}
        >
          Drop here to move block to the end
        </div>
      )}
      {depth > 0 && (
        <Field label="Add a question to this group">
          <select
            value=""
            onChange={(event) =>
              onChange([
                ...blocks,
                newBlock(event.target.value as EditableKind),
              ])
            }
          >
            <option value="" disabled>
              Choose block type…
            </option>
            {kinds
              .filter(
                (kind) =>
                  kind !== "candidate_vote" &&
                  (kind !== "repeated_group" || depth < 3),
              )
              .map((kind) => (
                <option key={kind} value={kind}>
                  {title(kind)}
                </option>
              ))}
          </select>
        </Field>
      )}
    </div>
  );
}
/** Authoring groups are explicit: enabling publication must never make a block
 * disappear by removing it from an unsupported-only catch-all group.
 */
export function Palette({ add }: { add: (type: EditableKind) => void }) {
  return (
    <aside className="tb-panel tb-palette">
      <div className="tb-eyebrow">TOOLBOX</div>
      <h2>Block library</h2>
      <p className="tb-muted">Choose a block to add it.</p>
      {(["Answer fields", "Specialized / display fields"] as const).map(
        (group, index) => (
          <div key={group} className="tb-palette-group">
            <h3>{group}</h3>
            {kinds
              .filter((kind) =>
                index === 0
                  ? [
                      "single_choice",
                      "multiple_choice",
                      "boolean",
                      "number",
                      "rating_scale",
                      "text",
                      "transcript",
                      "ranking",
                      "audio_comparison",
                      "repeated_group",
                    ].includes(kind)
                  : [
                      "section",
                      "callout",
                      "audio_player",
                      "timeline_annotation",
                      "transcript_summary",
                    ].includes(kind),
              )
              .map((kind) => (
                <button
                  type="button"
                  key={kind}
                  aria-label={"Add " + title(kind)}
                  onClick={() => add(kind)}
                >
                  <span className="tb-type">{catalog[kind][2]}</span>
                  <span>
                    <strong>{title(kind)}</strong>
                    <small>{catalog[kind][1]}</small>
                  </span>
                  <Plus size={15} />
                </button>
              ))}
          </div>
        ),
      )}
    </aside>
  );
}
