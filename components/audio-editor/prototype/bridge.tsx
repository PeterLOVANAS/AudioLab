/** Minimal compatibility primitives from the prototype's shared.tsx/schema.ts.
 * We deliberately do not import the legacy network layer or database schema.
 */
export function clientId(): string {
  // Persisted interval IDs only need to be unique within one annotation.
  return crypto.randomUUID();
}
export function Badge({ children }: { children: React.ReactNode }) {
  return <span className="r-prototype-badge">{children}</span>;
}
/** Union of playback ranges, clipped to the audio duration. */
export function coverageSeconds(ranges: number[][], duration: number): number {
  const valid = ranges
    .map(([s, e]) => [Math.max(0, s), Math.min(duration, e)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let seconds = 0,
    previousEnd = 0;
  for (const [s, e] of valid) {
    seconds += Math.max(0, e - Math.max(previousEnd, s));
    previousEnd = Math.max(previousEnd, e);
  }
  return seconds;
}
