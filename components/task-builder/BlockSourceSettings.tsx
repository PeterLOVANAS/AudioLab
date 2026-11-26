"use client";
import type { Block } from "./model";
import type { SourceFieldDescriptor } from "@/lib/contracts/source-fields";
import type { SourceBindings } from "@/lib/contracts/input-bindings";
import { resolveBoundBlocks } from "@/lib/frontend/source-binding";
import { parseTextGrid } from "@/lib/audio/textgrid";
import { originalChoiceValue } from "@/lib/contracts/source-reference";

/** Per-block mappings update only the protocol. Source values remain in the
 * selected item and are resolved/pinned by the server when an assignment opens.
 */
export default function BlockSourceSettings({
  block,
  fields,
  values,
  onChange,
}: {
  block: Block;
  fields?: SourceFieldDescriptor[];
  values?: Array<{ field: SourceFieldDescriptor; value: unknown }>;
  onChange: (block: Block) => void;
}) {
  const available = (
    fields ??
    ([
      {
        id: "question",
        type: "string",
        visibility: "worker",
        provenance: "source_records",
      },
      {
        id: "choices",
        type: "string[]",
        visibility: "worker",
        provenance: "source_records",
      },
    ] as SourceFieldDescriptor[])
  ).filter(
    (f) =>
      f.visibility === "worker" ||
      (block.trainingAnswerPreview && f.id === "reference_answer"),
  );
  const bindings = block.sourceBindings ?? {};
  const update = (next: SourceBindings, changes: Partial<Block> = {}) =>
    onChange({
      ...block,
      ...changes,
      sourceBindings: Object.keys(next).length ? next : undefined,
    });
  function select(target: keyof SourceBindings, id: string) {
    const next = { ...bindings };
    if (!id) {
      delete next[target];
      update(next);
      return;
    }
    const field = available.find((f) => f.id === id);
    if (!field) return;
    if (target === "preview") {
      next.preview = {
        kind: "dataset",
        fieldId: id,
        type: field.type as NonNullable<SourceBindings["preview"]>["type"],
      };
      update(next, { showSourceAnswer: true });
      return;
    }
    if (target === "options")
      next.options = {
        kind: "dataset",
        fieldId: id,
        type: field.type as "choices" | "string[]" | "string",
        format: field.type === "string" ? "json" : "array",
      };
    else if (target === "value") {
      next.value = {
        kind: "dataset",
        fieldId: id,
        type: field.type === "textgrid" ? "textgrid" : "string",
        mode:
          field.type === "textgrid"
            ? "prefill"
            : (bindings.value?.mode ?? "read_only"),
      };
      if (field.type === "textgrid") {
        const raw = values?.find((f) => f.field.id === id)?.value;
        if (typeof raw === "string") {
          const grid = parseTextGrid(raw);
          const tiers = grid.tiers.map((t, i) => {
            const existing = block.tiers?.find(
              (v) => v.name.toLowerCase() === t.name.toLowerCase(),
            );
            return existing
              ? { ...existing, name: t.name }
              : {
                  id: `grid-${i + 1}`,
                  name: t.name,
                  kind: "interval" as const,
                  labelMode: "text" as const,
                  allowOverlap: true,
                };
          });
          update(next, { tiers });
          return;
        }
      }
    } else next[target] = { kind: "dataset", fieldId: id, type: "string" };
    update(next, next.value?.mode === "read_only" ? { required: false } : {});
  }
  function picker(
    target: keyof SourceBindings,
    label: string,
    types: string[],
  ) {
    const current = bindings[target]?.fieldId ?? "";
    const options = available.filter((f) => types.includes(f.type));
    return (
      <label className="tb-field">
        <span>{label}</span>
        <select
          value={current}
          onChange={(e) => select(target, e.target.value)}
        >
          <option value="">Manual / no dataset binding</option>
          {current && !options.some((f) => f.id === current) && (
            <option value={current}>
              {current} (not present in this sample)
            </option>
          )}
          {options.map((f) => (
            <option key={f.id} value={f.id}>
              {f.id} ({f.type})
            </option>
          ))}
        </select>
      </label>
    );
  }
  let preview: Block | undefined,
    problem = "";
  if (Object.keys(bindings).length) {
    try {
      preview = resolveBoundBlocks([block], {
        audioUrl: "",
        // Builder is admin-only. Release this one field only after the author
        // explicitly selects training; production capture enforces it again.
        fields: (values ?? []).map((v) =>
          block.trainingAnswerPreview && v.field.id === "reference_answer"
            ? {
                ...v,
                value: originalChoiceValue(v.value) ?? undefined,
                field: { ...v.field, visibility: "worker" },
              }
            : v,
        ),
      })[0];
    } catch (error) {
      problem = error instanceof Error ? error.message : "Source unavailable";
    }
  }
  return (
    <fieldset className="tb-source-settings">
      <legend>Dataset content for this block</legend>
      <p className="tb-muted">
        Select fields once; the assigned item supplies its own content.
        Protected answers stay private unless explicitly released for training.
      </p>
      <div className="tb-grid">
        {picker("label", "Question / title", ["string"])}
        {picker("helpText", "Description / helper", ["string"])}
      </div>
      {["single_choice", "multiple_choice"].includes(block.type) && (
        <>
          {picker("options", "Choices source", [
            "choices",
            "string[]",
            "string",
          ])}
          {bindings.options && (
            <div className="tb-grid">
              <label className="tb-field">
                <span>Stored choices format</span>
                <select
                  value={bindings.options.format ?? "array"}
                  onChange={(e) =>
                    update({
                      ...bindings,
                      options: {
                        ...bindings.options!,
                        format: e.target.value as NonNullable<
                          SourceBindings["options"]
                        >["format"],
                      },
                    })
                  }
                >
                  {bindings.options.type !== "string" ? (
                    <option value="array">Array of choices</option>
                  ) : (
                    <>
                      <option value="json">JSON array stored as text</option>
                      <option value="lines">One choice per line</option>
                      <option value="delimiter">Literal separator</option>
                    </>
                  )}
                </select>
              </label>
              {bindings.options.format === "delimiter" && (
                <label className="tb-field">
                  <span>Separator (literal, e.g. |)</span>
                  <input
                    maxLength={8}
                    value={bindings.options.delimiter ?? ""}
                    onChange={(e) =>
                      update({
                        ...bindings,
                        options: {
                          ...bindings.options!,
                          delimiter: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              )}
              <label className="tb-check">
                <input
                  type="checkbox"
                  checked={bindings.options.stripPrefix ?? false}
                  onChange={(e) =>
                    update({
                      ...bindings,
                      options: {
                        ...bindings.options!,
                        stripPrefix: e.target.checked,
                      },
                    })
                  }
                />
                Remove labels such as A. or 1)
              </label>
            </div>
          )}
        </>
      )}
      {["text", "transcript"].includes(block.type) && (
        <>
          {picker("value", "Imported text", ["string"])}
          {bindings.value && (
            <label className="tb-field">
              <span>Use imported text as</span>
              <select
                value={bindings.value.mode}
                onChange={(e) =>
                  update(
                    {
                      ...bindings,
                      value: {
                        ...bindings.value!,
                        mode: e.target.value as
                          "read_only" | "reference" | "prefill",
                      },
                    },
                    e.target.value === "read_only" ? { required: false } : {},
                  )
                }
              >
                <option value="read_only">Read-only display</option>
                <option value="reference">Reference beside answer</option>
                <option value="prefill">Editable prefill</option>
              </select>
            </label>
          )}
        </>
      )}
      {block.type === "timeline_annotation" && (
        <>
          {picker("value", "Automatically load dataset TextGrid (optional)", [
            "textgrid",
          ])}
          <p className="tb-muted">
            Opt in here to prefill this block. Original TextGrid files remain
            preserved; saved drafts take precedence. Manual Grounding import
            remains available.
          </p>
          {bindings.value && (
            <p className="tb-muted">
              Tier names: {(block.tiers ?? []).map((t) => t.name).join(", ")}. A
              missing source or mismatched tier blocks the task explicitly.
            </p>
          )}
        </>
      )}
      {["single_choice", "multiple_choice"].includes(block.type) && (
        <label className="tb-check">
          <input
            type="checkbox"
            checked={block.trainingAnswerPreview ?? false}
            onChange={(e) => {
              const next = { ...bindings };
              if (
                !e.target.checked &&
                next.preview?.fieldId === "reference_answer"
              )
                delete next.preview;
              update(next, {
                trainingAnswerPreview: e.target.checked,
                ...(e.target.checked ? {} : { showSourceAnswer: false }),
              });
            }}
          />
          Training task: allow original answer preview for labellers
        </label>
      )}
      {block.trainingAnswerPreview && (
        <p className="tb-muted">
          This explicitly reveals the selected original answer in newly created
          assignments. Training responses are not blind evaluation. Existing
          tasks and published versions stay unchanged.
        </p>
      )}
      {picker("preview", "Existing answer preview", [
        "string",
        "number",
        "boolean",
        "choices",
        "textgrid",
        ...(block.trainingAnswerPreview ? ["json"] : []),
      ])}
      <label className="tb-check">
        <input
          type="checkbox"
          checked={block.showSourceAnswer ?? false}
          onChange={(event) => {
            const next = { ...bindings };
            if (
              !event.target.checked &&
              next.preview?.fieldId === "reference_answer"
            )
              delete next.preview;
            update(next, { showSourceAnswer: event.target.checked });
          }}
        />
        Show existing answer in Preview and Workspace
      </label>
      <p className="tb-muted">
        This read-only panel is separate from your response. Protected reference
        answers require explicit training mode above.
      </p>
      {preview && (
        <div className="tb-source-preview">
          <strong>Current item preview</strong>
          <p>{preview.label}</p>
          {preview.helpText && <p>{preview.helpText}</p>}
          {preview.sourceAnswerPreview !== undefined && (
            <p>
              Existing answer:{" "}
              {typeof preview.sourceAnswerPreview === "string"
                ? preview.sourceAnswerPreview
                : JSON.stringify(preview.sourceAnswerPreview)}
            </p>
          )}
          {preview.options && bindings.options && (
            <ul>
              {preview.options.map((option) => (
                <li key={option.id}>{option.label}</li>
              ))}
            </ul>
          )}
          {preview.type === "callout" && <p>{preview.description}</p>}
          {bindings.value?.type === "textgrid" && (
            <p>
              TextGrid ready: {preview.tiers?.map((t) => t.name).join(", ")}
            </p>
          )}
        </div>
      )}
      {problem && (
        <p role="status" className="tb-muted">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
