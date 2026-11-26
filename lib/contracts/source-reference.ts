/** Extract only a choice answer from imported labels. Arbitrary nested JSON,
 * provenance and sibling private metadata must never enter a training preview.
 * Unsupported legacy shapes are unavailable rather than guessed or coerced. */
export function originalChoiceValue(
  payload: unknown,
): string | string[] | null {
  const value =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "value" in payload
      ? (payload as { value: unknown }).value
      : payload;
  if (typeof value === "string" && value.trim() && value.length <= 20000)
    return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 50 &&
    value.every((v) => typeof v === "string" && v.trim() && v.length <= 20000)
  )
    return value;
  return null;
}
