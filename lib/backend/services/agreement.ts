/** Workflow-independent block-aware agreement. Callers must first scope independent
 * immutable revisions to the same dataset item/audio/definition version/block.
 * These functions never select a winning revision or mutate an annotation.
 */
export type Interval = { start: number; end: number; label: string };
/** Exact-set overlap; duplicate selections are not independent votes. Empty sets agree. */
export function jaccard(a: string[], b: string[]): number {
  const x = new Set(a),
    y = new Set(b);
  const union = new Set([...x, ...y]);
  return union.size ? [...x].filter((v) => y.has(v)).length / union.size : 1;
}
/** Pairwise ordering agreement on a full permutation (Kendall concordance). */
export function rankingAgreement(a: string[], b: string[]): number {
  if (
    new Set(a).size !== a.length ||
    new Set(b).size !== b.length ||
    a.length !== b.length ||
    jaccard(a, b) !== 1
  )
    throw new Error("Rankings must contain the same distinct IDs");
  let same = 0,
    total = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++) {
      total++;
      if (b.indexOf(a[i]) < b.indexOf(a[j])) same++;
    }
  return total ? same / total : 1;
}
/** Unicode/whitespace normalization is comparison policy, never a rewrite of stored answers. */
export function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en");
}
/** Levenshtein distance uses O(length of b) memory; cap input to bound QC work. */
export function editDistance(a: string, b: string): number {
  if (a.length > 20000 || b.length > 20000 || a.length * b.length > 4000000)
    throw new Error("Text comparison exceeds work limit");
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length];
}
/** Temporal IoU; labels must match exactly and intervals must have positive duration. */
export function temporalIoU(a: Interval, b: Interval): number {
  for (const v of [a, b])
    if (
      !Number.isFinite(v.start) ||
      !Number.isFinite(v.end) ||
      v.start < 0 ||
      v.end <= v.start
    )
      throw new Error("Invalid interval");
  if (a.label !== b.label) return 0;
  const overlap = Math.max(
    0,
    Math.min(a.end, b.end) - Math.max(a.start, b.start),
  );
  return overlap / (a.end - a.start + b.end - b.start - overlap);
}
/** Maximum-weight one-to-one matching via subset DP. Small bounded event batches
 * avoid greedy matching's incorrect correspondence when events overlap.
 */
export function intervalAgreement(a: Interval[], b: Interval[]): number {
  if (a.length > 12 || b.length > 12)
    throw new Error("Compare at most 12 events per batch");
  for (const event of [...a, ...b]) temporalIoU(event, event);
  const scores = a.map((x) => b.map((y) => temporalIoU(x, y)));
  let dp = new Map<number, number>([[0, 0]]);
  for (const row of scores) {
    const next = new Map(dp);
    for (const [mask, score] of dp)
      for (let j = 0; j < b.length; j++)
        if (!(mask & (1 << j))) {
          const key = mask | (1 << j);
          next.set(key, Math.max(next.get(key) ?? 0, score + row[j]));
        }
    dp = next;
  }
  return Math.max(a.length, b.length)
    ? Math.max(...dp.values()) / Math.max(a.length, b.length)
    : 1;
}
/** Canonical counts for scalar votes; no arbitrary tie-breaking. */
export function exactVotes(values: Array<string | boolean>): {
  unanimous: boolean;
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = Object.create(null);
  for (const v of values) {
    const key = JSON.stringify(v);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return {
    unanimous: values.length > 0 && Object.keys(counts).length === 1,
    counts,
  };
}

export type AgreementBlock = {
  id: string;
  type: string;
  required?: boolean;
  blocks?: AgreementBlock[];
};
/** Typed comparison result distinguishes equality from similarity. Group entries
 * align by position, never independently generated entry UUIDs. Different group
 * lengths return zero similarity; dataset-key alignment belongs to future imports.
 */
export function compareBlock(
  block: AgreementBlock,
  a: unknown,
  b: unknown,
): {
  exact: boolean;
  similarity: number;
  comparedCount?: number;
  skippedCount?: number;
} {
  function text(v: unknown): string {
    if (typeof v !== "string") throw new Error("Expected text");
    return v;
  }
  function list(v: unknown): string[] {
    if (
      !Array.isArray(v) ||
      !v.every((x) => typeof x === "string") ||
      new Set(v).size !== v.length
    )
      throw new Error("Expected distinct IDs");
    return v;
  }
  switch (block.type) {
    case "single_choice": {
      const exact = text(a) === text(b);
      return { exact, similarity: Number(exact) };
    }
    case "boolean": {
      if (typeof a !== "boolean" || typeof b !== "boolean")
        throw new Error("Expected boolean");
      return { exact: a === b, similarity: Number(a === b) };
    }
    case "multiple_choice": {
      const similarity = jaccard(list(a), list(b));
      return { exact: similarity === 1, similarity };
    }
    case "ranking": {
      const similarity = rankingAgreement(list(a), list(b));
      return { exact: similarity === 1, similarity };
    }
    case "text":
    case "transcript": {
      const x = normalizedText(text(a)),
        y = normalizedText(text(b));
      return {
        exact: x === y,
        similarity: 1 - editDistance(x, y) / Math.max(x.length, y.length, 1),
      };
    }
    case "time_intervals": {
      function events(v: unknown): Interval[] {
        if (
          !Array.isArray(v) ||
          !v.every(
            (e) =>
              e &&
              typeof e === "object" &&
              typeof e.label === "string" &&
              typeof e.start === "number" &&
              typeof e.end === "number",
          )
        )
          throw new Error("Expected labeled intervals");
        return v;
      }
      const similarity = intervalAgreement(events(a), events(b));
      return { exact: similarity === 1, similarity };
    }
    case "repeated_group": {
      function entries(
        v: unknown,
      ): Array<{ answers: Record<string, unknown> }> {
        if (
          !Array.isArray(v) ||
          !v.every(
            (e) =>
              e &&
              typeof e === "object" &&
              e.answers &&
              typeof e.answers === "object" &&
              !Array.isArray(e.answers),
          )
        )
          throw new Error("Expected repeated answers");
        return v;
      }
      const x = entries(a),
        y = entries(b);
      if (x.length !== y.length) return { exact: false, similarity: 0 };
      if (!block.blocks?.length) throw new Error("Group child schema required");
      let comparedCount = 0,
        skippedCount = 0,
        weightedSimilarity = 0;
      let exact = true;
      for (const [index, entry] of x.entries())
        for (const child of block.blocks) {
          // Display context is not an annotation. Two absent optional answers are
          // excluded, not counted as unanimous agreement or fabricated text.
          if (
            [
              "section",
              "callout",
              "audio_player",
              "transcript_summary",
            ].includes(child.type)
          ) {
            skippedCount++;
            continue;
          }
          const left = Object.hasOwn(entry.answers, child.id);
          const right = Object.hasOwn(y[index].answers, child.id);
          if (!left && !right) {
            if (child.required)
              throw new Error("Required group child answer is missing");
            skippedCount++;
            continue;
          }
          if (!left || !right) {
            comparedCount++;
            exact = false;
            continue;
          }
          const result = compareBlock(
            child,
            entry.answers[child.id],
            y[index].answers[child.id],
          );
          const count = result.comparedCount ?? 1;
          comparedCount += count;
          skippedCount += result.skippedCount ?? 0;
          weightedSimilarity += result.similarity * count;
          if (count && !result.exact) exact = false;
        }
      // Zero comparable answers is no evidence, never 100% agreement. Counts
      // let callers exclude this observation from trends/worker performance.
      return {
        exact: comparedCount > 0 && exact,
        similarity: comparedCount ? weightedSimilarity / comparedCount : 0,
        comparedCount,
        skippedCount,
      };
    }
    default:
      throw new Error("Unsupported agreement block type");
  }
}
export type AgreementSubmission = {
  projectId: string;
  datasetId: string;
  itemId: string;
  audioId: string;
  definitionId: string;
  definitionVersion: number;
  blockId: string;
  revisionId: string;
  actorId: string;
  value: unknown;
};
/** Reject mixed provenance before computing agreement; this is not authorization.
 * Workflow services must independently load eligible immutable final revisions.
 */
export function compareScopedAnswers(
  block: AgreementBlock,
  a: AgreementSubmission,
  b: AgreementSubmission,
) {
  for (const key of [
    "projectId",
    "datasetId",
    "itemId",
    "audioId",
    "definitionId",
    "definitionVersion",
    "blockId",
  ] as const)
    if (a[key] !== b[key])
      throw new Error("Agreement sources belong to different scopes");
  if (
    a.blockId !== block.id ||
    a.actorId === b.actorId ||
    a.revisionId === b.revisionId
  )
    throw new Error("Independent source revisions required");
  return {
    ...compareBlock(block, a.value, b.value),
    revisionIds: [a.revisionId, b.revisionId],
    blockId: block.id,
  };
}
