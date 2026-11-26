/** Explicit source normalization shared by Builder preview and server validation.
 * Never eval Python strings or split JSON on commas: punctuation belongs to labels.
 */
export type ChoiceFormat = "array" | "json" | "lines" | "delimiter";
export function normalizeSourceChoices(
  raw: unknown,
  format: ChoiceFormat = "array",
  delimiter?: string,
  stripPrefix = false,
): Array<{ id: string; label: string }> {
  let values: unknown = raw;
  if (format !== "array") {
    if (typeof raw !== "string")
      throw new Error("This choice format requires a text source");
    if (format === "json") {
      try {
        values = JSON.parse(raw);
      } catch {
        throw new Error("Choices must be a valid JSON array");
      }
    } else if (format === "lines")
      values = raw.split(/\r?\n/).filter((v) => v.trim());
    else {
      if (!delimiter || delimiter.length > 8)
        throw new Error("Choose a literal separator of 1–8 characters");
      values = raw.split(delimiter).filter((v) => v.trim());
    }
  }
  if (!Array.isArray(values) || values.length < 2 || values.length > 50)
    throw new Error("Choices require 2–50 entries");
  const options = values.map((value, index) => {
    let id: string, label: string;
    if (typeof value === "string") {
      id = `source-choice-${index + 1}`;
      label = value;
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.label === "string" &&
      Object.keys(value).every((k) => ["id", "label"].includes(k))
    ) {
      id = value.id;
      label = value.label;
    } else throw new Error("Each choice must be text or an {id,label} object");
    label = label.trim();
    if (stripPrefix) label = label.replace(/^(?:[A-Za-z]|\d+)[).:]\s+/, "");
    if (id === "__custom__" || !id.trim() || id.length > 80 || !label || label.length > 2000)
      throw new Error("Choice IDs and labels must be nonempty and bounded");
    return { id, label };
  });
  if (new Set(options.map((o) => o.id)).size !== options.length)
    throw new Error("Choice IDs must be distinct");
  return options;
}
