"use client";
import { useEffect, useRef, useState } from "react";
export function Acoustics({
  samples,
  rate,
  offset,
  end,
  selection,
  onSelection,
  time,
  aids,
  boundaries = [],
  onClickTime,
  onBeforeSelect,
  onFit,
  onSelectionEnd,
  cursor,
  decimals = 3,
}: {
  samples: Float32Array;
  rate: number;
  offset: number;
  end: number;
  selection: [number, number];
  onSelection: (r: [number, number]) => void;
  time: number;
  aids: any;
  boundaries?: number[];
  onClickTime?: (t: number) => void;
  onBeforeSelect?: () => boolean;
  onFit?: () => void;
  onSelectionEnd?: () => void;
  cursor?: number;
  decimals?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    anchor = useRef<number | null>(null),
    [result, setResult] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [windowMs, setWindow] = useState(25),
    [maxHz, setMaxHz] = useState(5000),
    [floor, setFloor] = useState(60),
    [ceiling, setCeiling] = useState(500),
    [range, setRange] = useState(65),
    [showSpec, setSpec] = useState(true),
    [showPitch, setPitch] = useState(true),
    [showFormants, setFormants] = useState(false),
    [showMfcc, setMfcc] = useState(false),
    [pitchPanel, setPitchPanel] = useState(false),
    [energyPanel, setEnergyPanel] = useState(false);
  const tooLong = end - offset > 20;
  useEffect(() => {
    setResult(null);
    setError("");
    if (tooLong) return;
    setBusy(true);
    const worker = new Worker("/acoustic-worker.js", { type: "module" });
    worker.onmessage = (e) => {
      setResult(e.data.result);
      setError(e.data.error || "");
      setBusy(false);
    };
    worker.onerror = () => {
      setError(
        "Acoustic analysis could not start in this browser. Waveform annotation remains available.",
      );
      setBusy(false);
    };
    const pad = Math.max(windowMs / 2000, 1.6 / floor),
      from = Math.max(0, Math.floor((offset - pad) * rate)),
      part = samples.slice(
        from,
        Math.min(samples.length, Math.ceil((end + pad) * rate)),
      );
    worker.postMessage(
      {
        samples: part,
        rate,
        start: offset,
        windowMs,
        floor,
        ceiling,
        visibleOffset: Math.floor(offset * rate) - from,
        visibleLength: Math.max(1, Math.ceil((end - offset) * rate)),
      },
      [part.buffer],
    );
    return () => worker.terminate();
  }, [samples, rate, offset, end, windowMs, floor, ceiling, tooLong]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !result) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const width = result.columns.length,
      height = 256;
    c.width = width;
    c.height = height;
    const data = ctx.createImageData(width, height),
      hz = Math.min(maxHz, rate / 2);
    let peak = -120;
    for (const col of result.columns)
      for (const v of col) peak = Math.max(peak, v);
    for (let x = 0; x < width; x++)
      for (let y = 0; y < height; y++) {
        const bin = Math.min(
            result.columns[x].length - 1,
            Math.round((((height - 1 - y) / (height - 1)) * hz) / result.binHz),
          ),
          v = result.columns[x][bin],
          level = Math.max(0, Math.min(1, (v - (peak - range)) / range)),
          p = (y * width + x) * 4;
        data.data[p] = Math.round(245 - level * 221);
        data.data[p + 1] = Math.round(247 - level * 215);
        data.data[p + 2] = Math.round(252 - level * 198);
        data.data[p + 3] = 255;
      }
    ctx.putImageData(data, 0, 0);
  }, [result, maxHz, range, rate, showSpec]);
  function at(e: React.PointerEvent) {
    const r = e.currentTarget.getBoundingClientRect();
    return (
      offset +
      Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (end - offset)
    );
  }
  function curve(values: any[], min: number, max: number) {
    let d = "",
      last = false;
    values.forEach((v, i) => {
      if (v === null || (max > 100 && min === 0 && (v < min || v > max))) {
        last = false;
        return;
      }
      d += `${last ? "L" : "M"}${(i / (values.length - 1)) * 1000},${100 - Math.max(0, Math.min(1, (v - min) / (max - min))) * 100} `;
      last = true;
    });
    return d;
  }
  const x = (v: number) => ((v - offset) / (end - offset)) * 100;
  return (
    <div className="r-acoustics">
      <details className="r-analysis-settings">
        <summary>Acoustic aids · settings</summary>
        <div className="r-analysis-controls">
          {aids.spectrogram && (
            <label>
              <input
                type="checkbox"
                checked={showSpec}
                onChange={(e) => setSpec(e.target.checked)}
              />{" "}
              Spectrogram
            </label>
          )}
          {aids.pitch && (
            <label>
              <input
                type="checkbox"
                checked={showPitch}
                onChange={(e) => setPitch(e.target.checked)}
              />{" "}
              F0
            </label>
          )}
          {aids.spectrogram && (
            <>
              <label>
                Window{" "}
                <select
                  value={windowMs}
                  onChange={(e) => setWindow(+e.target.value)}
                >
                  <option value={5}>5 ms · boundaries</option>
                  <option value={25}>25 ms · balanced</option>
                  <option value={40}>40 ms · harmonics</option>
                </select>
              </label>
              <label>
                Max Hz{" "}
                <select
                  value={maxHz}
                  onChange={(e) => setMaxHz(+e.target.value)}
                >
                  {[4000, 5000, 8000].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Contrast{" "}
                <select
                  value={range}
                  onChange={(e) => setRange(+e.target.value)}
                >
                  {[45, 65, 85].map((v) => (
                    <option key={v} value={v}>
                      {v} dB
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {aids.pitch && (
            <label>
              F0 range{" "}
              <select
                aria-label="Pitch range"
                value={`${floor}-${ceiling}`}
                onChange={(e) => {
                  const [a, b] = e.target.value.split("-").map(Number);
                  setFloor(a);
                  setCeiling(b);
                }}
              >
                <option value="60-500">60–500 Hz</option>
                <option value="50-300">50–300 Hz</option>
                <option value="100-700">100–700 Hz</option>
              </select>
            </label>
          )}
          {aids.formants && (
            <label>
              <input
                type="checkbox"
                checked={showFormants}
                onChange={(e) => setFormants(e.target.checked)}
              />{" "}
              F1–F5 estimates
            </label>
          )}
          {aids.mfcc && (
            <label>
              <input
                type="checkbox"
                checked={showMfcc}
                onChange={(e) => setMfcc(e.target.checked)}
              />{" "}
              MFCC 1–13
            </label>
          )}
          {aids.pitch && (
            <label>
              <input
                type="checkbox"
                checked={pitchPanel}
                onChange={(e) => setPitchPanel(e.target.checked)}
              />{" "}
              Separate pitch panel
            </label>
          )}
          {aids.energy && (
            <label>
              <input
                type="checkbox"
                checked={energyPanel}
                onChange={(e) => setEnergyPanel(e.target.checked)}
              />{" "}
              Energy panel
            </label>
          )}
        </div>
      </details>
      {tooLong ? (
        <p className="r-hint">
          Zoom the waveform to a window of 20 seconds or less to analyze speech.
        </p>
      ) : (
        <>
          {busy && <p role="status">Analyzing visible audio…</p>}
          {error && <p role="alert">{error}</p>}
          {result && (
            <div
              className="r-acoustic-plots"
              onDoubleClick={onFit}
              onPointerDown={(e) => {
                if (onBeforeSelect && !onBeforeSelect()) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                anchor.current = at(e);
                onSelection([anchor.current, anchor.current]);
              }}
              onPointerMove={(e) => {
                if (anchor.current !== null) {
                  const t = at(e);
                  onSelection([
                    Math.min(t, anchor.current),
                    Math.max(t, anchor.current),
                  ]);
                }
              }}
              onPointerUp={(e) => {
                if (
                  anchor.current !== null &&
                  Math.abs(at(e) - anchor.current) < 0.005
                )
                  onClickTime?.(anchor.current);
                anchor.current = null;
                onSelectionEnd?.();
              }}
              onPointerCancel={() => {
                anchor.current = null;
              }}
            >
              {aids.spectrogram && showSpec && (
                <div className="r-spectrogram">
                  <canvas
                    ref={canvas}
                    aria-label="Spectrogram: drag to select audio"
                  />
                  <span className="r-plot-label">
                    {Math.min(maxHz, rate / 2)} Hz
                  </span>
                  <span className="r-plot-bottom">0 Hz</span>
                  <svg
                    className="r-spectral-overlay"
                    viewBox="0 0 1000 100"
                    preserveAspectRatio="none"
                  >
                    {showPitch && aids.pitch && (
                      <path
                        d={curve(result.f0, 0, Math.min(maxHz, rate / 2))}
                        fill="none"
                        stroke="#2366e5"
                        strokeWidth="2"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    {showFormants &&
                      aids.formants &&
                      [0, 1, 2, 3, 4].map((k) => (
                        <path
                          key={k}
                          d={curve(
                            result.formantTracks.map((v: any) => v[k] ?? null),
                            0,
                            Math.min(maxHz, rate / 2),
                          )}
                          fill="none"
                          stroke={
                            [
                              "#df3b39",
                              "#c33f86",
                              "#a44dbe",
                              "#dd8629",
                              "#85653d",
                            ][k]
                          }
                          strokeWidth="1.5"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                    {boundaries
                      .filter((t) => t >= offset && t <= end)
                      .map((t, i) => (
                        <line
                          key={i}
                          x1={x(t) * 10}
                          x2={x(t) * 10}
                          y1="0"
                          y2="100"
                          stroke="#0b8994"
                          strokeWidth="1"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                  </svg>
                </div>
              )}
              {aids.pitch &&
                showPitch &&
                (pitchPanel || !showSpec || !aids.spectrogram) && (
                  <div className="r-pitch-plot">
                    <span className="r-plot-label">
                      F0 · {floor}–{ceiling} Hz
                    </span>
                    <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
                      <path
                        d={curve(result.f0, floor, ceiling)}
                        fill="none"
                        stroke="#2563eb"
                        strokeWidth="2"
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                  </div>
                )}
              {aids.mfcc && showMfcc && (
                <div className="r-mfcc-plot">
                  <span className="r-plot-label">
                    MFCC · coefficients 1–13 (not Hz)
                  </span>
                  <svg
                    viewBox={`0 0 ${result.mfcc.length} 13`}
                    preserveAspectRatio="none"
                  >
                    {result.mfcc.flatMap((col: number[], i: number) =>
                      col.map((v: number, j: number) => (
                        <rect
                          key={`${i}-${j}`}
                          x={i}
                          y={j}
                          width={1}
                          height={1}
                          fill={`hsl(${v >= 0 ? 24 : 215} 65% ${95 - Math.min(1, Math.abs(v) / 50) * 60}%)`}
                        />
                      )),
                    )}
                  </svg>
                </div>
              )}
              {aids.energy && energyPanel && (
                <div className="r-energy-plot">
                  <span className="r-plot-label">Energy · −80 to 0 dBFS</span>
                  <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
                    <path
                      d={curve(result.energy, -80, 0)}
                      fill="none"
                      stroke="#0c8c75"
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                </div>
              )}
              {selection[1] > selection[0] && (
                <div
                  className="r-selection"
                  style={{
                    left: `${x(selection[0])}%`,
                    width: `${x(selection[1]) - x(selection[0])}%`,
                  }}
                />
              )}
              {[...new Set([cursor ?? selection[0], ...selection])]
                .filter((t) => t >= offset && t <= end)
                .map((t, i) => (
                  <div
                    key={i}
                    className="r-edit-cursor"
                    style={{ left: `${x(t)}%` }}
                  >
                    <span>{t.toFixed(decimals)} s</span>
                  </div>
                ))}
              {time >= offset && time <= end && (
                <div className="r-playhead" style={{ left: `${x(time)}%` }} />
              )}
            </div>
          )}
        </>
      )}
      <details className="r-analysis-notes">
        <summary>About these estimates</summary>
        <p className="r-hint">
          Click to place the cursor; drag to select and label. Use Play or Space
          to listen. Blue F0 and optional F1–F5 estimates share the
          spectrogram’s frequency axis; boundary lines align with the tiers. F0
          gaps indicate low periodicity, not necessarily silence. LPC
          spectral-envelope peaks are rough formant candidates, not validated
          Praat tracks; missing or merged resonances can shift their numbering.
          MFCCs have their own coefficient axis. Energy is relative to the
          digital signal, not calibrated loudness.
        </p>
      </details>
    </div>
  );
}
