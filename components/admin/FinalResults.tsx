"use client";
import { useRef, useState } from "react";
import type { JobResults, ResultItem } from "@/lib/contracts/job-results";
import { ReadableValue } from "./ReadableAnnotation";
import "./final-results.css";
const percent = (value: number | null) =>
  value === null ? "Unavailable" : `${(100 * value).toFixed(1)}%`;
/** Render backend counts without recalculating answers or merging question scopes. */
export function Distribution({ item }: { item: ResultItem }) {
  const distribution = item.distribution;
  if (!distribution) return null; // Older cached API responses remain readable.
  return (
    <div className="question-distribution">
      {distribution.counts.map((c) => (
        <div className="job-result-bar" key={c.id}>
          <span>{c.label}</span>
          <meter
            min={0}
            max={Math.max(1, item.validObservations)}
            value={c.count}
          />
          <b>{c.count}</b>
        </div>
      ))}
      {distribution.ranks.length > 0 && (
        <>
          <p>
            Rank-position frequencies. Each valid complete ranking contributes
            once per recording/label. Position 1 is highest; counts describe
            preference, not accuracy.
          </p>
          {distribution.ranks.map((r) => (
            <section className="rank-distribution" key={r.id}>
              <h5>{r.label}</h5>
              <div
                className="rank-bars"
                aria-label={`Rank positions for ${r.label}`}
              >
                {r.positions.map((count, position) => (
                  <div key={position}>
                    <span>Rank {position + 1}</span>
                    <meter
                      min={0}
                      max={Math.max(1, item.validObservations)}
                      value={count}
                    />
                    <b>{count}</b>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
/** Pure rendering of backend-authoritative metrics. Sorting and histogram bins
 * change presentation only; no client IoU or reference-answer inference exists. */
export default function FinalResults({ results }: { results: JobResults }) {
  const [selected, setSelected] = useState(""),
    [onlyLow, setOnlyLow] = useState(false);
  const [view, setView] = useState<"question" | "reference" | "pooled">(
    "question",
  );
  const [blockFilter, setBlockFilter] = useState("");
  const [limit, setLimit] = useState(20);
  if (!results.complete)
    return (
      <p role="status">
        Final Results unlock after all assignments are submitted.{" "}
        {results.remaining} submissions remain. Progress is available in the
        other views.
      </p>
    );
  const shown = results.items.filter(
    (i) =>
      (!blockFilter || i.blockId === blockFilter) &&
      (!onlyLow || (i.mean !== null && i.mean < 0.5)),
  );
  const descriptive = shown.filter(
    (i) =>
      i.distribution &&
      (i.distribution.counts.length || i.distribution.ranks.length),
  );
  const workers = new Map<
    string,
    { name: string; matched: number; compared: number; excluded: number }
  >();
  for (const row of shown.filter((i) => i.reference))
    for (const o of row.observations) {
      const worker = workers.get(o.workerId) ?? {
        name: o.displayName,
        matched: 0,
        compared: 0,
        excluded: 0,
      };
      const match = row.reference?.observations.find(
        (r) => r.workerId === o.workerId,
      )?.match;
      if (typeof match === "boolean") {
        worker.compared++;
        if (match) worker.matched++;
      } else worker.excluded++;
      workers.set(o.workerId, worker);
    }
  const item = results.items.find((i) => i.key === selected);
  const temporal = results.items.filter(
    (i) => i.block.type === "timeline_annotation",
  );
  const pairs = temporal.flatMap((i) =>
    i.pairs.flatMap((p) => (p.score === null ? [] : [p.score])),
  );
  const bins = Array.from(
    { length: 5 },
    (_, index) =>
      pairs.filter((score) => Math.min(4, Math.floor(score * 5)) === index)
        .length,
  );
  return (
    <div className="final-results">
      <p>{results.policy}</p>
      {results.items.some(
        (i) => i.block.trainingAnswerPreview && i.block.showSourceAnswer,
      ) && (
        <p role="status">
          <strong>Training results:</strong> Original answers were deliberately
          shown. Match rates are descriptive training feedback and are not blind
          accuracy evidence.
        </p>
      )}
      <div className="admin-toolbar">
        <label>
          Question block{" "}
          <select
            aria-label="Results question block"
            value={blockFilter}
            onChange={(e) => {
              setBlockFilter(e.target.value);
              setLimit(20);
            }}
          >
            {[
              <option value="" key="all">
                All blocks
              </option>,
              ...results.blocks.map((b) => (
                <option key={b.blockId} value={b.blockId}>
                  {b.label} · {b.blockId}
                </option>
              )),
            ]}
          </select>
        </label>
        <div
          className="progress-views"
          role="group"
          aria-label="Distribution view"
        >
          <button
            aria-pressed={view === "question"}
            onClick={() => setView("question")}
          >
            Per-question votes
          </button>
          <button
            aria-pressed={view === "reference"}
            onClick={() => setView("reference")}
          >
            Original-answer matching
          </button>
          <button
            aria-pressed={view === "pooled"}
            onClick={() => setView("pooled")}
          >
            Pooled class frequencies
          </button>
        </div>
      </div>
      {view === "question" && (
        <section aria-label="Per-question distributions">
          <h3>Votes per question / recording</h3>
          <p>
            Each card is one pinned question and recording scope. Counts are
            submitted valid observations, not assignment or unique-audio counts.
            Repeated child entries retain their worker-local identity.
          </p>
          {!descriptive.length && (
            <p>
              No categorical or ranking distributions for these blocks. Use the
              per-item inspector for submitted responses.
            </p>
          )}
          {descriptive.slice(0, limit).map((row) => (
            <article className="job-result" key={row.key}>
              <h4>{row.block.label}</h4>
              <p>{row.audio.map((a) => a.label).join(" · ")}</p>
              <small>
                Task {row.taskInstanceId} · v{row.definitionVersion} ·{" "}
                {row.path}
              </small>
              <p>
                {row.validObservations} valid observations ·{" "}
                {row.excludedObservations} excluded/unavailable ·{" "}
                {row.eligiblePairs} eligible agreement pairs
              </p>
              <Distribution item={row} />
              <button onClick={() => setSelected(row.key)}>
                Inspect question and labeller answers
              </button>
            </article>
          ))}
          {descriptive.length > limit && (
            <button onClick={() => setLimit((n) => n + 20)}>
              Show 20 more questions ({descriptive.length - limit} remaining)
            </button>
          )}
        </section>
      )}
      {view === "reference" && (
        <section aria-label="Reference matching">
          <h3>Exact match to original imported answers</h3>
          <p>
            This is separate from inter-annotator agreement. Each denominator
            counts comparable question responses, including separate audio
            panels in a batch. Unavailable, ambiguous and missing responses are
            excluded explicitly. References are current imported answers, not
            pinned historical truth. Training previews invalidate blind
            evaluation.
          </p>
          {![...workers.values()].some((w) => w.compared) && (
            <p>
              No comparable original references available for this selection.
            </p>
          )}
          {[...workers].map(([id, w]) => (
            <div className="job-result" key={id}>
              <h4>{w.name}</h4>
              <div className="job-result-bar">
                <span>Matched questions</span>
                <meter
                  min={0}
                  max={Math.max(1, w.compared)}
                  value={w.matched}
                />
                <b>
                  {w.matched} / {w.compared}
                </b>
              </div>
              <p>
                {w.compared} comparable responses · {w.excluded}{" "}
                excluded/unavailable responses ·{" "}
                {w.compared ? percent(w.matched / w.compared) : "Unavailable"}
              </p>
            </div>
          ))}
        </section>
      )}
      {view === "pooled" && (
        <p>
          Pooled class frequencies combine questions in a block. Use them for
          shared classification labels; source-choice ordinals are item-local
          and their different labels remain separate. These are not per-question
          voting statistics.
        </p>
      )}
      {!results.blocks.length && (
        <p>No answer blocks in this published task.</p>
      )}
      {results.blocks
        .filter((b) => !blockFilter || b.blockId === blockFilter)
        .map((block) => (
          <article className="job-result" key={block.blockId}>
            <h3>
              {block.label}{" "}
              <small>
                {block.type} · {block.blockId}
              </small>
            </h3>
            <p>
              {block.metric}: <strong>{percent(block.meanSimilarity)}</strong>
            </p>
            {block.numeric && (
              <p>
                Numeric observations: {block.numeric.count} · mean{" "}
                {block.numeric.mean} · minimum {block.numeric.min} · maximum{" "}
                {block.numeric.max}
              </p>
            )}
            <p>
              {block.validObservations} valid observations ·{" "}
              {block.excludedObservations} excluded/unavailable observations ·{" "}
              {block.validComparisons} eligible pairs · {block.unresolved}{" "}
              excluded pairs ({block.absencePairs} explicit absence agreements)
            </p>
            {view === "pooled" &&
              block.counts.map((choice) => (
                <div className="job-result-bar" key={choice.id}>
                  <span>{choice.label}</span>
                  <meter
                    min={0}
                    max={Math.max(1, ...block.counts.map((c) => c.count))}
                    value={choice.count}
                  />
                  <b>{choice.count}</b>
                </div>
              ))}
          </article>
        ))}
      {temporal.length > 0 && (
        <section>
          <h3>Grounding IoU distribution</h3>
          <p>
            Eligible unordered labeller pairs across item/block/audio scopes.
            Excluded pairs are not in these bins.
          </p>
          {bins.map((count, index) => (
            <div className="job-result-bar" key={index}>
              <span>
                {index * 20}–{(index + 1) * 20}%
                {index < 4 ? " (upper bound excluded)" : ""}
              </span>
              <meter min={0} max={Math.max(1, ...bins)} value={count} />
              <b>{count}</b>
            </div>
          ))}
        </section>
      )}
      <h3>Per-item results</h3>
      <label>
        <input
          type="checkbox"
          checked={onlyLow}
          onChange={(e) => setOnlyLow(e.target.checked)}
        />{" "}
        Show low agreement only (&lt;50%, available metrics)
      </label>
      <div className="admin-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Recording / task</th>
              <th>Resolved block</th>
              <th>Mean</th>
              <th>Observations valid / excluded</th>
              <th>Pairs eligible / excluded</th>
              <th>Inspect</th>
            </tr>
          </thead>
          <tbody>
            {[...shown]
              .sort((a, b) => (a.mean ?? 2) - (b.mean ?? 2))
              .map((row) => (
                <tr key={row.key}>
                  <td>
                    {row.audio.map((a) => a.label).join(", ")}
                    <small>
                      {row.taskInstanceId} · v{row.definitionVersion}
                    </small>
                  </td>
                  <td>
                    {row.block.label}
                    <small>{row.path}</small>
                  </td>
                  <td>{percent(row.mean)}</td>
                  <td>
                    {row.validObservations} / {row.excludedObservations}
                  </td>
                  <td>
                    {row.eligiblePairs} / {row.excludedPairs}
                  </td>
                  <td>
                    <button onClick={() => setSelected(row.key)}>
                      Inspect results
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!shown.length && <p>No observations match this filter.</p>}
      {item && (
        <ResultInspector
          key={item.key}
          item={item}
          onClose={() => setSelected("")}
        />
      )}
    </div>
  );
}
/** One selected pinned task/block/audio scope. Native audio supplies actual time;
 * tracks use a common seconds axis and retain original unmerged submitted events.
 * Missing metadata uses decoded audio duration; scores always come from the API. */
export function ResultInspector({
  item,
  onClose,
}: {
  item: ResultItem;
  onClose: () => void;
}) {
  const player = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0),
    [decodedDuration, setDuration] = useState<number | null>(null),
    [audioError, setAudioError] = useState("");
  const duration = item.audio[0]?.duration ?? decodedDuration;
  const maxEvent = Math.max(
    0,
    ...item.tracks.flatMap((t) => t.events.map((e) => e.end)),
  );
  // Without asset metadata/decoding, show an explicitly labelled event extent;
  // this never clips raw intervals or implies that playback duration is known.
  const scale = duration ?? Math.max(1, maxEvent);
  const temporal = item.block.type === "timeline_annotation";
  const identities = [
    ...new Set(
      item.tracks.flatMap((t) =>
        t.events.map((e) => JSON.stringify([e.tierId, e.label])),
      ),
    ),
  ];
  return (
    <section className="result-inspector" aria-label="Result inspector">
      <div className="admin-toolbar">
        <h3>{item.block.label} — submitted results</h3>
        <button onClick={onClose}>Close inspector</button>
      </div>
      <p>
        Task {item.taskInstanceId} · definition {item.definitionId} v
        {item.definitionVersion} · {item.path}
      </p>
      <p>Source items: {item.sourceKeys.join(", ")}</p>
      <Distribution item={item} />
      {item.reference && (
        <div>
          <h4>Original-answer matching</h4>
          <p>{item.reference.reason}</p>
          {item.reference.observations.map((r, i) => (
            <p key={`${r.workerId}:${i}`}>
              {item.observations.find((o) => o.workerId === r.workerId)
                ?.displayName ?? r.workerId}
              :{" "}
              {r.match === null
                ? "Unavailable"
                : r.match
                  ? "Matches original answer"
                  : "Does not match original answer"}
            </p>
          ))}
        </div>
      )}
      {item.audio.map((audio, index) => (
        <div key={audio.id}>
          <p>
            {audio.label} · {audio.id}
          </p>
          <audio
            ref={index === 0 ? player : undefined}
            controls
            preload="metadata"
            src={audio.url}
            onTimeUpdate={
              index === 0
                ? (e) => setTime(e.currentTarget.currentTime)
                : undefined
            }
            onLoadedMetadata={
              index === 0
                ? (e) => {
                    if (Number.isFinite(e.currentTarget.duration))
                      setDuration(e.currentTarget.duration);
                  }
                : undefined
            }
            onError={() =>
              setAudioError(
                "Audio unavailable. Check access permission or storage; submitted annotation data is retained.",
              )
            }
          />
        </div>
      ))}
      {audioError && (
        <p role="alert" className="admin-error">
          {audioError}
        </p>
      )}
      {temporal && (
        <>
          <p>
            Time in seconds ·{" "}
            {duration === null
              ? "recording duration unavailable; axis shows event extent"
              : `recording duration ${duration.toFixed(2)}s`}{" "}
            · playback {time.toFixed(2)}s
          </p>
          <label>
            Seek recording{" "}
            <input
              aria-label="Seek recording"
              type="range"
              min={0}
              max={scale}
              step="0.01"
              value={Math.min(time, scale)}
              disabled={!duration}
              onChange={(e) => {
                if (player.current) {
                  player.current.currentTime = Number(e.target.value);
                  setTime(Number(e.target.value));
                }
              }}
            />
          </label>
          <div className="interval-tracks">
            {item.observations.map((o, index) => {
              const track = item.tracks.find((t) => t.observation === index);
              return (
                <section key={o.assignmentId}>
                  <h4>
                    {o.displayName} ·{" "}
                    {o.state === "empty" ? "Explicit absence" : o.state}
                  </h4>
                  {track?.events.length ? (
                    <svg
                      viewBox={`0 0 1000 ${Math.max(1, identities.length) * 32 + 24}`}
                      role="img"
                      aria-label={`Submitted intervals for ${o.displayName}`}
                    >
                      {identities.map((identity, lane) => (
                        <line
                          key={identity}
                          x1={0}
                          x2={1000}
                          y1={lane * 32 + 30}
                          y2={lane * 32 + 30}
                          stroke="#cbd5e1"
                        />
                      ))}
                      {track.events.map((event, eventIndex) => {
                        const lane = identities.indexOf(
                          JSON.stringify([event.tierId, event.label]),
                        );
                        return (
                          <g key={eventIndex}>
                            <title>{`${event.tierId}: ${event.label}, ${event.start}–${event.end} seconds`}</title>
                            <rect
                              x={(1000 * event.start) / scale}
                              width={(1000 * (event.end - event.start)) / scale}
                              y={lane * 32 + 4}
                              height={24}
                              fill="#346a8a"
                              opacity="0.7"
                            />
                            <text
                              x={(1000 * event.start) / scale + 3}
                              y={lane * 32 + 21}
                              fill="white"
                              fontSize={13}
                            >
                              {event.label}
                            </text>
                          </g>
                        );
                      })}
                      <line
                        x1={(1000 * time) / scale}
                        x2={(1000 * time) / scale}
                        y1={0}
                        y2={Math.max(1, identities.length) * 32}
                        stroke="#c44b3e"
                        strokeWidth={2}
                      />
                      <text
                        x={0}
                        y={Math.max(1, identities.length) * 32 + 19}
                        fontSize={13}
                      >
                        0 s
                      </text>
                      <text
                        x={1000}
                        textAnchor="end"
                        y={Math.max(1, identities.length) * 32 + 19}
                        fontSize={13}
                      >
                        {scale.toFixed(2)} s
                      </text>
                    </svg>
                  ) : (
                    <p>
                      {o.state === "empty"
                        ? "No events explicitly submitted."
                        : (o.reason ?? "No intervals available.")}
                    </p>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
      <p>
        {item.metric}: mean {percent(item.mean)} · minimum {percent(item.min)} ·
        maximum {percent(item.max)}
      </p>
      <p>
        {item.eligiblePairs} valid comparisons · {item.excludedPairs} excluded
        comparisons · {item.absencePairs} absence agreements
      </p>
      {item.numeric && (
        <p>
          Numeric observations: {item.numeric.count} · mean {item.numeric.mean}{" "}
          · minimum {item.numeric.min} · maximum {item.numeric.max}
        </p>
      )}
      <div className="admin-table-scroll">
        <table aria-label="Pairwise agreement matrix">
          <thead>
            <tr>
              <th>Labeller</th>
              {item.observations.map((o) => (
                <th key={o.assignmentId}>{o.displayName}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {item.observations.map((o, i) => (
              <tr key={o.assignmentId}>
                <th>{o.displayName}</th>
                {item.observations.map((p, j) => {
                  const pair = item.pairs.find(
                    (p) =>
                      p.left === Math.min(i, j) && p.right === Math.max(i, j),
                  );
                  return (
                    <td key={p.assignmentId} title={pair?.reason}>
                      {i === j
                        ? "—"
                        : pair?.score === null
                          ? pair.absenceAgreement
                            ? "Absence agreement"
                            : `Unavailable: ${pair.reason}`
                          : percent(pair?.score ?? null)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Readable submitted annotations</h4>
      {item.observations.map((o) => (
        <details key={o.assignmentId}>
          <summary>
            {o.displayName} · {o.state} · revision {o.revisionId ?? "none"}
          </summary>
          {o.reason && <p>{o.reason}</p>}
          <ReadableValue value={o.readable} />
          <details>
            <summary>Raw persisted value and provenance</summary>
            <p>Assignment {o.assignmentId}</p>
            <pre>{JSON.stringify(o.value, null, 2)}</pre>
          </details>
        </details>
      ))}
      <p>
        No reference track: this response deliberately excludes private source
        labels. These scores measure agreement between independent labellers.
      </p>
    </section>
  );
}
