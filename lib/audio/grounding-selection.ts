export type TimeRange = readonly [number, number];
/** Move a labelled interval without changing its duration or identity. */
export function moveGroundingRange(
  range: TimeRange,
  delta: number,
  duration: number,
): [number, number] {
  if (
    ![...range, delta, duration].every(Number.isFinite) ||
    range[0] < 0 ||
    range[1] <= range[0] ||
    range[1] > duration
  )
    throw new Error("Invalid recording interval.");
  const shift = Math.max(-range[0], Math.min(duration - range[1], delta));
  return [range[0] + shift, range[1] + shift];
}
/** Clamp one edge to the recording and keep a positive one-sample interval. */
export function resizeGroundingRange(
  range: TimeRange,
  edge: "start" | "end",
  time: number,
  duration: number,
  sampleRate: number,
): [number, number] {
  if (
    ![...range, time, duration, sampleRate].every(Number.isFinite) ||
    duration <= 0 ||
    sampleRate <= 0
  )
    throw new Error("Invalid recording metadata.");
  const gap = 1 / sampleRate;
  return edge === "start"
    ? [Math.max(0, Math.min(range[1] - gap, time)), range[1]]
    : [range[0], Math.min(duration, Math.max(range[0] + gap, time))];
}
