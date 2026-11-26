/**
 * Optional linked-boundary interval update ported from prototype.
 * When linkAdjacent=true and two intervals share a boundary, updating one
 * moves the touching neighbour's boundary. This is a UI convenience, NOT
 * a global rule: phones can cross word boundaries and parent links are optional.
 */
// Preserve adjacent interval joins when moving an existing shared boundary.
export function commitSegment(items: any[], next: any, linkAdjacent = true) {
  const old = items.find((x) => x.id === next.id);
  const changed = items
    .filter((x) => x.id !== next.id)
    .map((x) => {
      if (
        !old ||
        !linkAdjacent ||
        x.speaker !== old.speaker ||
        x.concept_id !== old.concept_id
      )
        return x;
      let v = { ...x };
      if (Math.abs(x.end - old.start) < 1e-7) v.end = next.start;
      if (Math.abs(x.start - old.end) < 1e-7) v.start = next.end;
      if (v.start >= v.end)
        throw new Error(
          "The boundary would erase a neighbouring segment. Move it within the neighbouring interval, or turn off linked boundaries.",
        );
      return v;
    });
  if (next.start >= next.end)
    throw new Error("A segment needs a positive duration.");
  return [...changed, next].sort((a, b) => a.start - b.start || a.end - b.end);
}
