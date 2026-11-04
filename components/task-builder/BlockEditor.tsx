import { cloneElement, type ReactElement } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { AnnotationScope, BlockCondition } from "@/lib/contracts/tasks";
import {
  canSubmit,
  catalog,
  conditionSources,
  editable,
  hasChoiceOptions,
  kinds,
  moveBlock,
  newBlock,
  title,
  type Block,
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
          onChange(event.target.value === "" ? undefined : event.target.valueAsNumber)
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
      <input type="checkbox" checked={!!checked} onChange={(event) => onChange(event.target.checked)} />
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
    if (next.type === "number" || next.type === "rating_scale") equals = next.min ?? 0;
    change({ blockId: next.id, equals });
  }
  return (
    <div className="tb-grid">
      <Field label="Show this question">
        <select value={rule?.blockId ?? ""} onChange={(event) => choose(event.target.value)}>
          <option value="">Always</option>
          {rule && !source && <option value={rule.blockId}>Missing earlier question</option>}
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
              onChange={(event) => change({ ...rule, equals: event.target.value === "true" })}
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : source.type === "single_choice" ? (
            <select
              value={String(rule.equals)}
              onChange={(event) => change({ ...rule, equals: event.target.value })}
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
}: {
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
      <Switch
        label="Answer required"
        checked={block.required}
        onChange={(required) => set({ required })}
      />
      {hasChoiceOptions(block.type) && (
        <div className="tb-field">
          <span>Answer choices</span>
          {options.map((option, index) => (
            <div key={option.id || index} className="tb-option-edit">
              <span>{index + 1}</span>
              <input
                aria-label={"Choice " + (index + 1)}
                value={option.label}
                onChange={(event) =>
                  set({
                    options: options.map((item, position) =>
                      position === index ? { ...item, label: event.target.value } : item,
                    ),
                  })
                }
              />
              <button
                type="button"
                aria-label={"Remove choice " + (index + 1)}
                onClick={() => set({ options: options.filter((_, position) => position !== index) })}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="tb-link"
            onClick={() => set({ options: [...options, { id: crypto.randomUUID(), label: "" }] })}
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
                requiredValue: event.target.value === "" ? undefined : event.target.value === "true",
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
          <Numeric label="Minimum" value={block.min} onChange={(min) => set({ min })} />
          <Numeric label="Maximum" value={block.max} onChange={(max) => set({ max })} />
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
          <Numeric label="Step" value={block.step} onChange={(step) => set({ step })} />
          <div className="tb-grid">
            {(["minLabel", "maxLabel"] as const).map((key, index) => (
              <Field key={key} label={index ? "High end label" : "Low end label"}>
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
              onChange={(event) => set({ notation: event.target.value as Block["notation"] })}
            >
              <option value="orthographic">Normal spelling</option>
              <option value="ipa">IPA phonetic symbols</option>
            </select>
          </Field>
        </div>
      )}
      {block.type === "candidate_vote" && (
        <Switch
          label="Allow a suggested correction"
          checked={block.allowCorrection}
          onChange={(allowCorrection) => set({ allowCorrection })}
        />
      )}
      {(block.type === "ranking" || block.type === "audio_comparison") && (
        <>
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
                    set({ stimulusSlots: slots.filter((_, position) => position !== index) })
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
          <Switch
            label="Randomize recording order"
            checked={block.randomizeOrder}
            onChange={(randomizeOrder) => set({ randomizeOrder })}
          />
          {block.type === "ranking" && (
            <Switch
              label="Allow ties"
              checked={block.allowTies}
              onChange={(allowTies) => set({ allowTies })}
            />
          )}
        </>
      )}
      {block.type === "repeated_group" && depth === 0 && (
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
            <BlockEditor blocks={block.blocks ?? []} onChange={(blocks) => set({ blocks })} depth={1} />
          </div>
        </>
      )}
      <details className="tb-detail">
        <summary>Scope and visibility</summary>
        <div className="tb-settings">
          <Field label="Applies to">
            <select
              value={block.scope ?? "clip"}
              onChange={(event) => set({ scope: event.target.value as AnnotationScope })}
            >
              {["clip", "interval", "speaker", "event", "audio_pair", "candidate"].map((scope) => (
                <option key={scope} value={scope}>
                  {scope.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Condition block={block} prior={prior} change={(showWhen) => set({ showWhen })} />
        </div>
      </details>
    </div>
  );
}
export default function BlockEditor({
  blocks,
  onChange,
  depth = 0,
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  depth?: number;
}) {
  return (
    <div className="tb-list">
      {blocks.map((block, index) => (
        <section className="tb-block" data-block={block.id} key={block.id}>
          <details>
            <summary>
              <span className="tb-index">{String(index + 1).padStart(2, "0")}</span>
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
                block={block}
                prior={blocks.slice(0, index)}
                depth={depth}
                onChange={(changed) =>
                  onChange(blocks.map((item) => (item.id === block.id ? changed : item)))
                }
              />
            ) : (
              <p className="tb-inset">
                Managed by the grounding workspace. Its settings are preserved when you save.
              </p>
            )}
          </details>
          <div className="tb-block-tools">
            <span>{canSubmit(block.type) ? "Standard" : "Draft & preview"}</span>
            <button
              type="button"
              aria-label={"Move " + block.label + " up"}
              disabled={index === 0}
              onClick={() => onChange(moveBlock(blocks, index, -1))}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              aria-label={"Move " + block.label + " down"}
              disabled={index === blocks.length - 1}
              onClick={() => onChange(moveBlock(blocks, index, 1))}
            >
              <ArrowDown size={14} />
            </button>
            {editable(block.type) && (
              <button
                type="button"
                aria-label={"Remove " + block.label}
                onClick={() => onChange(blocks.filter((item) => item.id !== block.id))}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </section>
      ))}
      {depth > 0 && (
        <Field label="Add a question to this group">
          <select
            value=""
            onChange={(event) => onChange([...blocks, newBlock(event.target.value as EditableKind)])}
          >
            <option value="" disabled>
              Choose block type…
            </option>
            {kinds
              .filter((kind) => kind !== "repeated_group")
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
export function Palette({ add }: { add: (type: EditableKind) => void }) {
  return (
    <aside className="tb-panel tb-palette">
      <div className="tb-eyebrow">TOOLBOX</div>
      <h2>Block library</h2>
      <p className="tb-muted">Choose a block to add it.</p>
      {(["Standard fields", "Specialized fields"] as const).map((group, index) => (
        <div key={group} className="tb-palette-group">
          <h3>{group}</h3>
          {kinds
            .filter((kind) => canSubmit(kind) === (index === 0))
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
      ))}
    </aside>
  );
}
