import { jobResults } from "./job-results";
import {
  readableBlockAnswer,
  readableTaskAnswers,
} from "@/lib/contracts/readable-answers";
import { sourceFieldRepository } from "@/lib/backend/repositories/source-fields";
import { projectPublicSourceFields } from "./source-fields";
import type {
  ResearchExport,
  ExportRevision,
  ExportAudioItem,
  ExportAudioBlock,
  ResearchBlock,
  ChoiceDistribution,
} from "@/lib/contracts/research-export";
import { jobDetail } from "./team-jobs";
import { taskInstanceService } from "./task-instances";
import { parseTaskInputs } from "./task-inputs";
import { AuthError } from "@/lib/backend/auth/identity";

/** Count independent submitted answers, retaining zero-count published options.
 * Multi-choice counts are per selected option (percentages may total >100%).
 * This is descriptive distribution, never a consensus/adjudication decision.
 */
export function choiceDistribution(
  block: ResearchBlock,
  answers: unknown[],
): ChoiceDistribution {
  const options =
    block.type === "boolean"
      ? [
          { id: "true", label: "Yes" },
          { id: "false", label: "No" },
        ]
      : Array.isArray(block.options)
        ? (block.options as Array<{ id: string; label: string }>)
        : [];
  const counts = new Map(
    options.map((option) => [option.id, { ...option, count: 0 }]),
  );
  let submitted = 0;
  for (const raw of answers) {
    if (raw === undefined || raw === null) continue;
    submitted++;
    const wrapped =
      typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const selection =
      wrapped && "selection" in wrapped ? wrapped.selection : raw;
    for (const selected of new Set(
      Array.isArray(selection) ? selection : [selection],
    )) {
      const id = String(selected);
      if (id === "__custom__" && typeof wrapped?.customText === "string") {
        const customId = "custom:" + wrapped.customText;
        const entry = counts.get(customId) ?? {
          id: customId,
          label: wrapped.customText,
          count: 0,
        };
        entry.count++;
        counts.set(customId, entry);
      } else {
        const entry = counts.get(id);
        if (entry) entry.count++;
      }
    }
  }
  return { submitted, counts: [...counts.values()] };
}
const perAudioTypes = new Set([
  "single_choice",
  "multiple_choice",
  "boolean",
  "number",
  "text",
  "transcript",
  "rating_scale",
  "timeline_annotation",
]);
const choiceTypes = new Set(["single_choice", "multiple_choice", "boolean"]);
const displayTypes = new Set([
  "section",
  "callout",
  "audio_player",
  "transcript_summary",
]);

/** Build an admin-only research snapshot from pinned tasks and immutable finals.
 * Reuse the existing runtime resolver; never re-read today's mutable source data
 * to interpret an old answer. Queries exclude draft revisions and source_labels.
 * Batch-level answers stay at task scope. Audio extraction uses ordered slot IDs,
 * not filenames, question text or assumptions about fixed choice cardinality.
 */
export async function buildResearchExport(
  db: D1Database,
  actor: string,
  projectId: string,
  jobId: string,
): Promise<ResearchExport> {
  const detail = await jobDetail(db, actor, jobId, true);
  if (detail.summary.projectId !== projectId)
    throw new AuthError(403, "Job belongs to another project.");
  const rows = (
    await db
      .prepare(
        `SELECT a.id AS assignmentId,a.task_instance_id AS taskId,a.labeller_user_id AS workerId,
    r.id AS revisionId,r.revision,r.created_at AS submittedAt,r.answers_json AS answersJson
    FROM annotation_job_assignments ja JOIN assignments a ON a.id=ja.assignment_id
    LEFT JOIN annotation_revisions r ON r.id=(SELECT id FROM annotation_revisions WHERE assignment_id=a.id AND status='submitted' ORDER BY revision DESC LIMIT 1)
    WHERE ja.job_id=? ORDER BY a.task_instance_id,a.id`,
      )
      .bind(jobId)
      .all<{
        assignmentId: string;
        taskId: string;
        workerId: string;
        revisionId: string | null;
        revision: number | null;
        submittedAt: string | null;
        answersJson: string | null;
      }>()
  ).results;
  const snapshots = (
    await db
      .prepare(
        `SELECT DISTINCT i.id,i.input_snapshot_json AS json FROM task_instances i
    JOIN assignments a ON a.task_instance_id=i.id JOIN annotation_job_assignments ja ON ja.assignment_id=a.id WHERE ja.job_id=?`,
      )
      .bind(jobId)
      .all<{ id: string; json: string | null }>()
  ).results;
  const currentSources = snapshots.some((snapshot) => !snapshot.json)
    ? await sourceFieldRepository.forIds(
        db,
        projectId,
        detail.plan.input.datasetId,
        [
          ...new Set(
            detail.plan.items.flatMap((item) =>
              item.sourceId ? [item.sourceId] : [],
            ),
          ),
        ],
      )
    : [];
  const tasks: ResearchExport["tasks"] = [],
    audio = new Map<string, ExportAudioItem>();
  for (const taskId of new Set(rows.map((row) => row.taskId))) {
    const loadedTask = await taskInstanceService.get(db, taskId);
    // Use names frozen in the allocation plan alongside stable audio IDs.
    const task = {
      ...loadedTask,
      audioAssets: loadedTask.audioAssets?.map((asset) => ({
        ...asset,
        originalPath: detail.plan.items.find(
          (item) => item.assetId === asset.id,
        )?.originalPath,
      })),
    };
    const definition = task.resolvedDefinition ?? task.definition;
    const taskRows = rows.filter((row) => row.taskId === taskId);
    const annotations: ExportRevision[] = taskRows
      .filter((row) => row.revisionId && row.answersJson)
      .map((row) => ({
        readableAnswers: readableTaskAnswers(
          definition.blocks,
          JSON.parse(row.answersJson!),
          task.audioAssets?.map(
            (asset) => asset.originalPath ?? `Audio ${asset.position + 1}`,
          ),
        ),
        assignmentId: row.assignmentId,
        workerId: row.workerId,
        revisionId: row.revisionId!,
        revision: row.revision!,
        submittedAt: row.submittedAt!,
        answers: JSON.parse(row.answersJson!),
      }));
    const anchor = detail.assignments.find(
      (assignment) => assignment.id === taskRows[0].assignmentId,
    )!.itemKey;
    const sourceKeys = detail.plan.batches?.find(
      (batch) => batch.key === anchor,
    )?.itemKeys ?? [anchor];
    const snapshotRow = snapshots.find((row) => row.id === taskId);
    const snapshot = snapshotRow?.json
      ? parseTaskInputs(snapshotRow.json)
      : null;
    const sources = snapshot ? (snapshot.batch ?? [snapshot]) : [];
    const assets = task.audioAssets ?? [
      { id: task.assetId, url: task.audioUrl, position: 0 },
    ];
    const distributions: ResearchExport["tasks"][number]["distributions"] = [];
    for (const [position, asset] of assets.entries()) {
      const source = detail.plan.items.find(
        (item) => item.key === sourceKeys[position],
      );
      if (!source || source.assetId !== asset.id)
        throw new AuthError(
          409,
          "Frozen job source order differs from the Task Instance.",
        );
      let entry = audio.get(asset.id);
      if (!entry) {
        entry = {
          audioId: asset.id,
          originalPath: source.originalPath,
          audioUrl: asset.url,
          durationSeconds:
            "durationSeconds" in asset ? asset.durationSeconds : null,
          sourceItems: [],
          taskReferences: [],
        };
        audio.set(asset.id, entry);
      }
      if (!entry.taskReferences.includes(taskId))
        entry.taskReferences.push(taskId);
      const pinned = sources[position];
      const current = !pinned
        ? currentSources.find((row) => row.id === source.sourceId)
        : undefined;
      if (
        current &&
        (current.assetId !== source.assetId ||
          current.sourceRecordId !== source.recordId)
      )
        throw new AuthError(
          409,
          "Current source metadata identity differs from the frozen job.",
        );
      const fieldsOrigin = pinned
        ? "pinned-task-input"
        : current
          ? "current-source"
          : "none";
      // Static legacy protocols lack snapshots. Public metadata is labelled as
      // current, never used to reinterpret an old answer or its option IDs.
      const safeFields =
        pinned?.publicFields ??
        (current ? projectPublicSourceFields(current).fields : []);
      const fields = safeFields.map((field) => ({
        id: field.field.id,
        type: field.field.type,
        value: field.value,
      }));
      if (
        pinned?.question !== undefined &&
        !fields.some((field) => field.id === "question")
      )
        fields.push({ id: "question", type: "string", value: pinned.question });
      if (
        pinned?.choices !== undefined &&
        !fields.some((field) => field.id === "choices")
      )
        fields.push({ id: "choices", type: "choices", value: pinned.choices });
      const projected: ExportAudioBlock[] = [];
      for (const original of definition.blocks) {
        if (
          displayTypes.has(original.type) ||
          original.type === "ranking" ||
          original.type === "audio_comparison"
        )
          continue;
        const count =
          typeof original.numBatch === "number" ? original.numBatch : 1;
        const repeated = perAudioTypes.has(original.type) && count > 1;
        if (repeated ? position >= count : position !== 0) continue;
        const panel = (
          repeated && Array.isArray(original.batchBlocks)
            ? original.batchBlocks[position]
            : original
        ) as ResearchBlock;
        const block = { ...panel, numBatch: 1 };
        const values = annotations.flatMap(
          ({ answers, readableAnswers: _readableAnswers, ...revision }) => {
            const raw = answers[original.id];
            const value = repeated
              ? Array.isArray(raw)
                ? raw[position]
                : undefined
              : raw;
            return value === undefined || value === null
              ? []
              : [
                  {
                    ...revision,
                    value,
                    readableValue: readableBlockAnswer(block, value, [
                      entry.originalPath,
                    ]),
                  },
                ];
          },
        );
        const distribution =
          detail.summary.mode === "voting" && choiceTypes.has(block.type)
            ? choiceDistribution(
                block,
                values.map((value) => value.value),
              )
            : undefined;
        projected.push({
          taskInstanceId: taskId,
          block,
          annotations: values,
          ...(distribution ? { distribution } : {}),
        });
        if (distribution)
          distributions.push({
            blockId: block.id,
            audioPosition: position,
            value: distribution,
          });
      }
      entry.sourceItems.push({
        sourceKey: source.key,
        sampleId: source.sampleId,
        itemId: source.itemId,
        sourceRecordId: source.recordId,
        sourceVersion: source.sourceVersion,
        fieldsOrigin,
        ...(pinned
          ? { sourceUpdatedAt: pinned.source.sourceUpdatedAt }
          : current
            ? { sourceUpdatedAt: current.updatedAt }
            : {}),
        fields,
        blocks: projected,
      });
    }
    if (detail.summary.mode === "voting")
      for (const block of definition.blocks.filter(
        (block) => block.type === "audio_comparison",
      )) {
        const size =
          typeof block.comparisonSize === "number" ? block.comparisonSize : 2;
        const count = typeof block.numBatch === "number" ? block.numBatch : 2;
        for (let index = 0; index < count / size; index++)
          distributions.push({
            blockId: block.id,
            audioPosition: null,
            comparisonIndex: index,
            value: choiceDistribution(
              block,
              annotations.map(
                (annotation) =>
                  (annotation.answers[block.id] as unknown[] | undefined)?.[
                    index
                  ],
              ),
            ),
          });
      }
    tasks.push({
      id: taskId,
      task,
      sourceKeys,
      annotations,
      expectedSubmissions: detail.plan.pairs.filter(
        (pair) => pair.itemKey === anchor,
      ).length,
      distributions,
    });
  }
  const exportedSubmissions = tasks.reduce(
    (n, task) => n + task.annotations.length,
    0,
  );
  // Revision rows were selected in one statement. Derive completion from those
  // same immutable IDs instead of mixing counters read before a concurrent submit.
  const fullyLabelledItems = tasks
    .filter(
      (task) =>
        task.expectedSubmissions > 0 &&
        task.annotations.length === task.expectedSubmissions,
    )
    .reduce((count, task) => count + task.sourceKeys.length, 0);
  return {
    analytics: await jobResults(db, actor, jobId, true),
    schemaVersion: "audiolab.research-export/1",
    generatedAt: new Date().toISOString(),
    projectId,
    datasetId: detail.plan.input.datasetId,
    job: {
      ...detail.summary,
      submitted: exportedSubmissions,
      assignments: rows.length,
      fullyLabelledItems,
    },
    policy: {
      revisions: "latest-submitted",
      draftsIncluded: false,
      hiddenReferencesIncluded: false,
      workerIdsIncluded: true,
    },
    tasks,
    audioItems: [...audio.values()],
    totals: {
      sourceItems: detail.plan.items.length,
      taskInstances: tasks.length,
      expectedSubmissions: detail.plan.pairs.length,
      exportedSubmissions,
      annotatedAudio: [...audio.values()].filter((item) =>
        item.taskReferences.some(
          (id) => tasks.find((task) => task.id === id)!.annotations.length,
        ),
      ).length,
    },
  };
}
/** Per-audio file retains pointers AND whole-task annotations for Ranking and
 * Comparison. Their scope explicitly names every member recording, preventing a
 * batch result from being misrepresented as an independent answer for one audio.
 */
export function audioExportFile(data: ResearchExport, item: ExportAudioItem) {
  return {
    schemaVersion: data.schemaVersion,
    generatedAt: data.generatedAt,
    projectId: data.projectId,
    datasetId: data.datasetId,
    jobId: data.job.id,
    policy: data.policy,
    audioFile: `audio/${item.audioId}.wav`,
    audio: item,
    taskInstances: data.tasks
      .filter((task) => item.taskReferences.includes(task.id))
      .map((task) => ({
        id: task.id,
        definitionId: task.task.definitionId,
        definitionVersion: task.task.definitionVersion,
        definition: task.task.definition,
        resolvedDefinition: task.task.resolvedDefinition,
        annotationScope: "task-instance",
        audioIds: task.task.audioAssets?.map((asset) => asset.id) ?? [
          task.task.assetId,
        ],
        annotations: task.annotations,
      })),
  };
}
