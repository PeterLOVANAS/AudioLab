import { jobDetail } from "./team-jobs";
import { taskInstanceService } from "./task-instances";
import type {
  JobResults,
  ResultItem,
  ResultBlock,
} from "@/lib/contracts/job-results";
import type { ResearchBlock } from "@/lib/contracts/research-export";
import { analyzeItem, observation } from "./result-analytics";
import {
  referenceEvaluation,
  resultDistribution,
} from "./result-distributions";
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const perAudio = new Set([
  "single_choice",
  "multiple_choice",
  "boolean",
  "number",
  "text",
  "transcript",
  "rating_scale",
  "timeline_annotation",
]);
const display = new Set([
  "section",
  "callout",
  "audio_player",
  "transcript_summary",
]);
/** Admin-only analytics of immutable finals. Completion gating is unchanged.
 * Resolve each pinned Task Instance once, then scope comparisons to its exact
 * audio slot, block and repeated entry identity. References are read only after
 * jobDetail verifies administrator membership; only match outcomes are returned.
 * Job means are pair-weighted across eligible item-pairs, not duration/item means.
 */
export async function jobResults(
  db: D1Database,
  actor: string,
  id: string,
  includeArchived = false,
): Promise<JobResults> {
  const detail = await jobDetail(db, actor, id, includeArchived),
    expected = detail.plan.pairs.length;
  const base: JobResults = {
    analyticsVersion: "audiolab.analytics/2",
    distributionVersion: "audiolab.distributions/1",
    complete: false,
    remaining: Math.max(0, expected - detail.summary.submitted),
    sourceItems: detail.plan.items.length,
    uniqueAudioItems: new Set(detail.plan.items.map((i) => i.assetId)).size,
    workerSubmissions: detail.summary.submitted,
    expectedAssignments: expected,
    blocks: [],
    items: [],
    policy:
      "Final submitted revisions only. Inter-annotator agreement is not accuracy. Job scores are equally weighted eligible unordered pairs across pinned task/block/audio scopes. Empty-empty pairs report absence separately. Manual repeated entries have no cross-worker alignment contract; child responses are inspected separately. Reference matching is a separate exact-choice evaluation against current imported answers, not pinned historical ground truth. Training responses are not blind evaluation. Raw private references are not included.",
  };
  if (
    !detail.summary.launchedAt ||
    detail.assignments.length !== expected ||
    detail.summary.submitted !== expected
  )
    return base;
  // One bulk read of immutable submitted revisions: a latest draft must never
  // become a final observation merely because an assignment status says submitted.
  const finals = (
    await db
      .prepare(
        `SELECT a.id AS assignmentId,a.task_instance_id AS taskId,r.id AS revisionId,r.answers_json AS json
    FROM annotation_job_assignments ja JOIN assignments a ON a.id=ja.assignment_id
    LEFT JOIN annotation_revisions r ON r.id=(SELECT id FROM annotation_revisions WHERE assignment_id=a.id AND status='submitted' ORDER BY revision DESC LIMIT 1)
    WHERE ja.job_id=?`,
      )
      .bind(id)
      .all<{
        assignmentId: string;
        taskId: string;
        revisionId: string | null;
        json: string | null;
      }>()
  ).results;
  const items: ResultItem[] = [];
  // Bulk, project-scoped reference reads avoid per-item SQL and cannot reuse a
  // label from another project's asset. No arbitrary private metadata is read.
  const references = new Map<string, unknown[]>();
  const sourceIds = [
    ...new Set(
      detail.plan.items.flatMap((i) => (i.sourceId ? [i.sourceId] : [])),
    ),
  ];
  for (let start = 0; start < sourceIds.length; start += 80) {
    const chunk = sourceIds.slice(start, start + 80);
    const rows = await db
      .prepare(
        `SELECT sr.id AS sourceId,sl.payload_json AS payload
      FROM source_records sr JOIN audio_assets a ON a.id=sr.asset_id JOIN datasets d ON d.id=a.dataset_id
      JOIN source_labels sl ON sl.source_record_id=sr.id AND sl.kind='reference_answer'
      WHERE d.project_id=? AND d.id=? AND sr.id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(detail.summary.projectId, detail.plan.input.datasetId, ...chunk)
      .all<{ sourceId: string; payload: string }>();
    for (const row of rows.results) {
      const values = references.get(row.sourceId) ?? [];
      try {
        values.push(JSON.parse(row.payload));
      } catch {
        values.push(null);
      }
      references.set(row.sourceId, values);
    }
  }
  const batches =
    detail.plan.batches ??
    detail.plan.items.map((i) => ({ key: i.key, itemKeys: [i.key] }));
  for (const batch of batches) {
    const assignments = detail.assignments.filter(
      (a) => a.itemKey === batch.key,
    );
    const taskId = finals.find(
      (f) => f.assignmentId === assignments[0]?.id,
    )?.taskId;
    if (!taskId) continue;
    const task = await taskInstanceService.get(db, taskId),
      definition = task.resolvedDefinition ?? task.definition;
    const audios = (
      task.audioAssets?.length
        ? task.audioAssets
        : [{ id: task.assetId, url: task.audioUrl, position: 0 }]
    ).map((a) => ({
      id: a.id,
      url: a.url,
      label:
        detail.plan.items.find((i) => i.assetId === a.id)?.originalPath ?? a.id,
      duration:
        "durationSeconds" in a &&
        typeof a.durationSeconds === "number" &&
        a.durationSeconds > 0
          ? a.durationSeconds
          : null,
    }));
    const sources = assignments.map((a) => {
      const final = finals.find((f) => f.assignmentId === a.id);
      return {
        source: {
          workerId: a.userId,
          displayName:
            detail.plan.workers.find((w) => w.userId === a.userId)
              ?.displayName ?? a.userId,
          assignmentId: a.id,
          revisionId: final?.revisionId ?? null,
        },
        answers: final?.json
          ? (JSON.parse(final.json) as Record<string, unknown>)
          : {},
      };
    });
    function visit(
      block: ResearchBlock,
      values: unknown[],
      path: string,
      audio: typeof audios,
      resultType = block.type,
    ) {
      if (display.has(block.type)) return;
      const scoped: ResearchBlock = { ...block, numBatch: 1 };
      const analyzed = analyzeItem({
        key: JSON.stringify([taskId, path]),
        taskInstanceId: task.id,
        definitionId: task.definitionId,
        definitionVersion: task.definitionVersion,
        sourceKeys: batch.itemKeys.filter((key) =>
          detail.plan.items.some(
            (i) => i.key === key && audio.some((a) => a.id === i.assetId),
          ),
        ),
        blockId: path.split("/slot:")[0],
        path,
        block: scoped,
        audio,
        observations: sources.map((s, index) =>
          observation(
            scoped,
            values[index],
            s.source,
            !!s.source.revisionId,
            audio,
          ),
        ),
      });
      // Retain the original Audio Comparison identity for compatibility; its
      // per-group comparisons use the canonical single-choice validator/metric.
      if (resultType === "audio_comparison") {
        analyzed.block = { ...analyzed.block, type: resultType };
        analyzed.metric = "per-comparison exact agreement";
      }
      analyzed.distribution = resultDistribution(analyzed);
      if (
        ["single_choice", "multiple_choice"].includes(resultType) &&
        record(scoped.sourceBindings) &&
        scoped.sourceBindings.options
      ) {
        const source =
          analyzed.sourceKeys.length === 1
            ? detail.plan.items.find((i) => i.key === analyzed.sourceKeys[0])
            : null;
        analyzed.reference = referenceEvaluation(
          scoped,
          analyzed.observations,
          source?.sourceId ? (references.get(source.sourceId) ?? []) : [],
        );
      }
      items.push(analyzed);
      if (block.type === "repeated_group" && Array.isArray(block.blocks)) {
        const entries = values.flatMap((v, owner) =>
          Array.isArray(v)
            ? v.flatMap((e) =>
                record(e) && typeof e.id === "string"
                  ? [{ entryId: e.id, owner }]
                  : [],
              )
            : [],
        );
        // Manual group IDs are worker-local, not cross-worker event identity.
        // Keep children inspectable, but do not infer alignment from order or ID.
        for (const { entryId, owner } of entries)
          for (const child of block.blocks as ResearchBlock[]) {
            const childValues = values.map((v, index) => {
              if (index !== owner) return undefined;
              const entry = Array.isArray(v)
                ? v.find((e) => record(e) && e.id === entryId)
                : null;
              return record(entry) && record(entry.answers)
                ? entry.answers[child.id]
                : undefined;
            });
            visit(
              child,
              childValues,
              `${path}/worker:${sources[owner].source.workerId}/entry:${entryId}/${child.id}`,
              audio,
            );
          }
      }
    }
    for (const original of definition.blocks) {
      const values = sources.map((s) => s.answers[original.id]);
      const count =
        typeof original.numBatch === "number"
          ? original.numBatch
          : original.type === "audio_comparison"
            ? 2
            : 1;
      if (original.type === "audio_comparison") {
        const size =
          typeof original.comparisonSize === "number"
            ? original.comparisonSize
            : 2;
        for (let index = 0; index < count / size; index++)
          visit(
            { ...original, type: "single_choice" },
            values.map((v) => (Array.isArray(v) ? v[index] : undefined)),
            `${original.id}/slot:${index}`,
            audios.slice(index * size, (index + 1) * size),
            "audio_comparison",
          );
      } else if (perAudio.has(original.type) && count > 1) {
        for (let index = 0; index < count; index++)
          visit(
            Array.isArray(original.batchBlocks)
              ? (original.batchBlocks[index] as ResearchBlock)
              : original,
            values.map((v) => (Array.isArray(v) ? v[index] : undefined)),
            `${original.id}/slot:${index}`,
            audios.slice(index, index + 1),
          );
      } else
        visit(
          original,
          values,
          original.id,
          original.type === "ranking" ? audios : audios.slice(0, 1),
        );
    }
  }
  const blocks = new Map<string, ResultBlock>();
  for (const item of items) {
    let block = blocks.get(item.blockId);
    if (!block) {
      block = {
        blockId: item.blockId,
        label: item.block.label,
        type: item.block.type,
        counts: [],
        meanSimilarity: null,
        metric: item.metric,
        unresolved: 0,
        validComparisons: 0,
        comparisons: 0,
        comparisonGroups: 0,
        validObservations: 0,
        excludedObservations: 0,
        absencePairs: 0,
        numeric: null,
      };
      blocks.set(item.blockId, block);
    }
    block.validObservations += item.validObservations;
    block.excludedObservations += item.excludedObservations;
    block.unresolved += item.excludedPairs;
    block.validComparisons += item.eligiblePairs;
    block.comparisons += item.pairs.length;
    block.absencePairs += item.absencePairs;
    if (item.block.type === "audio_comparison") block.comparisonGroups++;
    if (
      [
        "single_choice",
        "multiple_choice",
        "boolean",
        "audio_comparison",
      ].includes(item.block.type)
    ) {
      // Include zero-count options; identical IDs with different resolved labels
      // remain separate populations instead of combining unrelated questions.
      const add = (id: string, label: string, amount: number) => {
        const key = JSON.stringify([id, label]);
        let row = block!.counts.find((c) => c.id === key);
        if (!row) {
          row = { id: key, label, count: 0 };
          block!.counts.push(row);
        }
        row.count += amount;
      };
      if (Array.isArray(item.block.options))
        for (const option of item.block.options as Array<{
          id: string;
          label: string;
        }>)
          add(option.id, option.label, 0);
      if (item.block.type === "boolean") {
        add("true", "Yes", 0);
        add("false", "No", 0);
      }
      for (const o of item.observations.filter((o) => o.state === "valid")) {
        const selected =
          record(o.value) && "selection" in o.value
            ? o.value.selection
            : o.value;
        for (const value of new Set(
          Array.isArray(selected) ? selected : [selected],
        )) {
          const option = Array.isArray(item.block.options)
            ? (item.block.options as Array<{ id: string; label: string }>).find(
                (c) => c.id === value,
              )
            : null;
          const label =
            value === "__custom__" && record(o.value)
              ? String(o.value.customText)
              : (option?.label ??
                (value === true
                  ? "Yes"
                  : value === false
                    ? "No"
                    : String(value)));
          add(String(value), label, 1);
        }
      }
    }
  }
  for (const block of blocks.values()) {
    const scores = items
      .filter((i) => i.blockId === block.blockId)
      .flatMap((i) =>
        i.pairs.flatMap((p) => (p.score === null ? [] : [p.score])),
      );
    block.meanSimilarity = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null;
    if (["number", "rating_scale"].includes(block.type)) {
      const values = items
        .filter((i) => i.blockId === block.blockId)
        .flatMap((i) =>
          i.observations
            .filter((o) => o.state === "valid")
            .flatMap((o) => (typeof o.value === "number" ? [o.value] : [])),
        );
      if (values.length)
        block.numeric = {
          count: values.length,
          mean: values.reduce((a, b) => a + b, 0) / values.length,
          min: Math.min(...values),
          max: Math.max(...values),
        };
    }
  }
  return {
    ...base,
    complete: true,
    remaining: 0,
    items,
    blocks: [...blocks.values()],
  };
}
