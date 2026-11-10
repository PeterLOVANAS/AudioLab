"use client";
/**
 * AudioLab v4 — advanced but reusable answer controls.
 *
 * All interactive state is CONTROLLED by BlockFields. Nothing in these
 * components writes to D1, knows an assignment ID, or sees reference labels.
 * The parent labeller will eventually send the answer under its block ID to
 * POST /api/v1/assignments/:id/annotation/{draft|submit}.
 *
 * Stable option IDs are stored; readable labels are never database keys.
 */
import { useState } from "react";
import type { Block, InlineFollowUp } from "@/components/task-builder/model";

export type AssetSample = { id: string; url: string; label: string };

/** An option-specific YES/NO, text, number or colored information panel.
 * Child answers belong to the parent choice's `children` dictionary, avoiding
 * dozens of confusing new top-level blocks in the Task Builder. */
export function FollowUps({
  items,
  answers,
  onChange,
}: {
  items: InlineFollowUp[];
  answers: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  function update(id: string, value: unknown) {
    onChange({ ...answers, [id]: value });
  }
  return (
    <div className="tb-inline-followups">
      {items.map((item) =>
        item.type === "callout" ? (
          <aside
            key={item.id}
            className={`tb-display tb-callout tb-tone-${item.tone ?? "info"}`}
          >
            <strong>{item.label}</strong>
            <p>{item.description}</p>
          </aside>
        ) : (
          <label key={item.id} className="tb-inline-child">
            <strong>
              {item.label}
              {item.required && " *"}
            </strong>
            {item.type === "boolean" && (
              <span>
                <input
                  type="checkbox"
                  checked={answers[item.id] === true}
                  onChange={(e) => update(item.id, e.target.checked)}
                />{" "}
                Yes, confirmed
              </span>
            )}
            {item.type === "text" && (
              <textarea
                rows={2}
                value={String(answers[item.id] ?? "")}
                onChange={(e) => update(item.id, e.target.value)}
              />
            )}
            {item.type === "number" && (
              <input
                type="number"
                value={
                  typeof answers[item.id] === "number"
                    ? (answers[item.id] as number)
                    : ""
                }
                onChange={(e) =>
                  update(
                    item.id,
                    e.target.value === "" ? undefined : e.target.valueAsNumber,
                  )
                }
              />
            )}
          </label>
        ),
      )}
    </div>
  );
}

/** AudioLab comparison batches are grouped in sequential fixed-size sets.
 * `numBatch` is the NUMBER OF WAVS, not the number of comparisons:
 * e.g. 8 WAVS / 2 WAVS per panel = four independent answer panels.
 */
export function AudioComparisonControl({
  block,
  value,
  assets,
  onChange,
}: {
  block: Block;
  value: unknown;
  assets: AssetSample[];
  onChange: (next: unknown) => void;
}) {
  const perPanel = block.comparisonSize ?? 2;
  const total = block.numBatch ?? 2;
  const groups = Number.isInteger(total / perPanel) ? total / perPanel : 0;
  const answers = Array.isArray(value) ? (value as unknown[]) : [];
  const options = block.options ?? [];
  const size = block.comparisonButtonSize ?? "md";
  const place = block.comparisonButtonPosition ?? "inside";
  const choiceRow = (group: number) => (
    <div className={`tb-comp-choices tb-comp-size-${size}`}>
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          aria-pressed={answers[group] === option.id}
          className={answers[group] === option.id ? "selected" : ""}
          onClick={() =>
            onChange(
              Array.from({ length: groups }, (_, i) =>
                i === group ? option.id : (answers[i] ?? null),
              ),
            )
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
  return (
    <div className="tb-comparison-grid">
      {Array.from({ length: groups }, (_, g) => (
        <div className="tb-comparison-unit" key={g}>
          <h4>
            Comparison {g + 1} of {groups}
          </h4>
          <div className="tb-comparison-tracks">
            {Array.from({ length: perPanel }, (_, i) => {
              const idx = g * perPanel + i,
                asset = assets[idx];
              return (
                <div key={idx} className="tb-comparison-audio">
                  <strong>
                    {block.stimulusSlots?.[i] ?? `Audio ${i + 1}`}
                  </strong>
                  {asset?.url ? (
                    <audio controls preload="none" src={asset.url} />
                  ) : (
                    <small>Choose audio #{idx + 1} in Preview Data</small>
                  )}
                  <small>{asset?.label ?? `Slot ${idx + 1}`}</small>
                </div>
              );
            })}
          </div>
          {place === "inside" && choiceRow(g)}
          {place === "outside" && (
            <div className="tb-comparison-below">{choiceRow(g)}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Accessible ranking: three AUTHOR-selected interaction modes share the
 * SAME persisted value: an ordered array of stable IDs. There is no coupling
 * between presentation (drag/arrows/typed order) and answer serialization.
 */
export function RankingControl({
  block,
  value,
  assets,
  onChange,
}: {
  block: Block;
  value: unknown;
  assets: AssetSample[];
  onChange: (next: string[]) => void;
}) {
  const labels =
    block.rankingMode === "labels"
      ? (block.rankLabels ?? [])
      : (block.stimulusSlots ?? []).map((name, index) => ({
          id: `slot-${index}`,
          label: name,
        }));
  const ids = labels.map((o) => o.id);
  const supplied = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && ids.includes(v))
    : [];
  const ordered = [...new Set([...supplied, ...ids])];
  const [dragId, setDragId] = useState("");
  const [csv, setCsv] = useState("");
  const [message, setMessage] = useState("");
  const mode = block.rankingInput ?? "drag";
  function move(from: number, to: number) {
    if (to < 0 || to >= ordered.length) return;
    const next = [...ordered];
    const [picked] = next.splice(from, 1);
    next.splice(to, 0, picked);
    onChange(next);
  }
  function submitCsv() {
    const entries = csv
      .split(/[,\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const positions = entries.map((x) => Number(x));
    if (
      positions.length !== ids.length ||
      new Set(positions).size !== ids.length ||
      positions.some((n) => !Number.isInteger(n) || n < 1 || n > ids.length)
    ) {
      setMessage(`Enter all ${ids.length} positions, e.g. 2,1,3`);
      return;
    }
    setMessage("");
    onChange(positions.map((n) => ids[n - 1]));
  }
  return (
    <div className="tb-ranking">
      <p className="tb-muted">
        Rank 1 = most preferred. Only one interaction method is active: {mode}.
      </p>
      {block.rankingMode === "audios" && (
        <div className="tb-ranking-sources">
          {labels.map((o, i) => (
            <div key={o.id}>
              <strong>
                {i + 1}. {o.label}
              </strong>
              {assets[i]?.url ? (
                <audio controls preload="none" src={assets[i].url} />
              ) : (
                <small>Audio pending</small>
              )}
            </div>
          ))}
        </div>
      )}
      {mode === "comma" && (
        <label className="tb-field">
          <span>Enter item numbers in preferred order (comma separated)</span>
          <input
            value={csv}
            placeholder={ids.map((_, i) => i + 1).join(",")}
            onChange={(e) => setCsv(e.target.value)}
          />
          <button type="button" onClick={submitCsv}>
            Apply ranking
          </button>
          {message && <small role="alert">{message}</small>}
        </label>
      )}
      <ol className="tb-ranking-order">
        {ordered.map((id, index) => {
          const item = labels.find((o) => o.id === id);
          return (
            <li
              key={id}
              draggable={mode === "drag"}
              onDragStart={() => setDragId(id)}
              onDragOver={(e) => {
                if (mode === "drag") e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                move(ordered.indexOf(dragId), index);
                setDragId("");
              }}
            >
              <span>{index + 1}.</span> {item?.label ?? id}
              {mode === "drag" && (
                <span aria-label="Drag this item"> ⠿ drag to reorder</span>
              )}
              {mode === "arrows" && (
                <span className="tb-ranking-arrows">
                  <button
                    type="button"
                    aria-label={`Move ${item?.label} up`}
                    disabled={index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${item?.label} down`}
                    disabled={index === ordered.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    ↓
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
