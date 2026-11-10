/**
 * Praat TextGrid interoperability, selectively carried forward from the
 * original AudioLab-for-Mac prototype rather than rewriting a tested parser.
 *
 * parseTextGrid(): reads Praat's text representation and validates intervals.
 * writeTextGrid(): writes IntervalTiers and inserts empty spans to preserve
 * the exact TextGrid time domain. Throws on overlaps *in the same tier*.
 *
 * Important: TextGrid does not preserve AudioLab speaker link IDs and other
 * annotation metadata. The canonical revision value remains JSON in D1.
 * Never treat an exported TextGrid as the sole authoritative research record.
 */
export type GridTier = {
  name: string;
  type: string;
  items: { start: number; end: number; text: string }[];
};
export function parseTextGrid(text: string) {
  if (text.length > 4_000_000) throw new Error("TextGrid must be below 4 MB.");
  const tokens: (string | number)[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s|\uFEFF/.test(text[i])) {
      i++;
      continue;
    }
    if (text[i] === "!") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === '"') {
      i++;
      let s = "",
        closed = false;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            s += '"';
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else s += text[i++];
      }
      if (!closed) throw new Error("Unclosed TextGrid string.");
      tokens.push(s);
      continue;
    }
    let s = "";
    while (i < text.length && !/\s/.test(text[i])) s += text[i++];
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s))
      tokens.push(Number(s));
    else if (s === "<exists>" || s === "<absent>") tokens.push(s);
  }
  let p = 0;
  const take = () => {
      if (p >= tokens.length) throw new Error("Incomplete TextGrid.");
      return tokens[p++];
    },
    num = () => {
      const v = take();
      if (typeof v !== "number" || !Number.isFinite(v))
        throw new Error("Expected a TextGrid number.");
      return v;
    },
    str = () => {
      const v = take();
      if (typeof v !== "string") throw new Error("Expected a TextGrid label.");
      return v;
    },
    count = () => {
      const n = num();
      if (!Number.isInteger(n) || n < 0 || n > 15000)
        throw new Error("Invalid TextGrid item count.");
      return n;
    };
  if (!str().startsWith("ooTextFile") || str() !== "TextGrid")
    throw new Error(
      "Use a text TextGrid (long or short format). Binary TextGrid is not supported.",
    );
  const start = num(),
    end = num();
  if (start < 0 || end <= start)
    throw new Error("Invalid TextGrid time domain.");
  const exists = str();
  if (exists !== "<exists>") throw new Error("TextGrid has no tiers.");
  const n = count(),
    tiers: GridTier[] = [],
    warnings: string[] = [];
  for (let t = 0; t < n; t++) {
    const type = str(),
      name = str(),
      lo = num(),
      hi = num(),
      size = count(),
      items = [];
    if (!["IntervalTier", "TextTier"].includes(type))
      throw new Error(`Unsupported tier ${type}`);
    let previous = lo;
    for (let j = 0; j < size; j++) {
      const a = num(),
        b = type === "IntervalTier" ? num() : a,
        label = str();
      if (
        a < lo ||
        b > hi ||
        a > b ||
        (type === "IntervalTier" && (a >= b || a < previous - 1e-7))
      )
        throw new Error(`Invalid or overlapping intervals in ${name}.`);
      previous = b;
      items.push({ start: a, end: b, text: label });
    }
    if (type === "TextTier")
      warnings.push(
        `Point tier “${name}” is not imported into interval tiers.`,
      );
    tiers.push({ name, type, items });
  }
  if (p !== tokens.length)
    throw new Error("Unexpected data after TextGrid tiers.");
  return { start, end, tiers, warnings };
}
export function gridAlignment(
  grid: ReturnType<typeof parseTextGrid>,
  wordTier: string,
  phoneTier: string,
  duration: number,
) {
  if (grid.end > duration + 0.05)
    throw new Error(
      "TextGrid extends beyond this audio. Choose the matching recording.",
    );
  if (wordTier && wordTier === phoneTier)
    throw new Error("Choose separate word and phone tiers.");
  const convert = (index: string, prefix: string) => {
    if (index === "") return [];
    const tier = grid.tiers[Number(index)];
    if (!tier || tier.type !== "IntervalTier")
      throw new Error("Choose an interval tier.");
    return tier.items
      .filter((i) => i.text.trim())
      .map((x, i) => ({
        ...x,
        id: `${prefix}-${i}`,
        end: Math.min(x.end, duration),
      }));
  };
  return {
    words: convert(wordTier, "import-word"),
    phonemes: convert(phoneTier, "import-phone"),
  };
}
export async function readAnnotationFile(file: File) {
  if (file.size > 4_000_000)
    throw new Error("Annotation files must be below 4 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let encoding = "utf-8";
  if (bytes[0] === 255 && bytes[1] === 254) encoding = "utf-16le";
  if (bytes[0] === 254 && bytes[1] === 255) encoding = "utf-16be";
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}
export function writeTextGrid(
  tiers: { name: string; items: any[] }[],
  duration: number,
) {
  const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
  const out = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    "",
    `xmin = 0`,
    `xmax = ${duration}`,
    "tiers? <exists>",
    `size = ${tiers.length}`,
    "item []:",
  ];
  tiers.forEach((t, k) => {
    let cursor = 0;
    const complete: any[] = [];
    for (const x of [...t.items].sort(
      (a, b) => a.start - b.start || a.end - b.end,
    )) {
      if (
        !Number.isFinite(x.start) ||
        !Number.isFinite(x.end) ||
        x.start < cursor - 1e-7 ||
        x.end > duration ||
        x.start >= x.end
      )
        throw new Error(
          `Tier ${t.name} has overlapping or invalid intervals. Resolve overlaps before TextGrid export; JSON can preserve overlaps.`,
        );
      if (x.start > cursor)
        complete.push({ start: cursor, end: x.start, text: "" });
      complete.push(x);
      cursor = x.end;
    }
    if (cursor < duration)
      complete.push({ start: cursor, end: duration, text: "" });
    out.push(
      `item [${k + 1}]:`,
      'class = "IntervalTier"',
      `name = ${quote(t.name)}`,
      "xmin = 0",
      `xmax = ${duration}`,
      `intervals: size = ${complete.length}`,
    );
    complete.forEach((x, i) =>
      out.push(
        `intervals [${i + 1}]:`,
        `xmin = ${x.start}`,
        `xmax = ${x.end}`,
        `text = ${quote(x.text)}`,
      ),
    );
  });
  return out.join("\n");
}
