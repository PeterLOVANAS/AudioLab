import type { Block } from "@/components/task-builder/model";
import { originalChoiceValue } from "@/lib/contracts/source-reference";
import type { TaskInputSnapshot } from "@/lib/contracts/input-bindings";
import type { PublishedDefinitionData } from "@/lib/contracts/task-instances";
import {
  SOURCE_FIELD_CATALOG,
  type WorkerSourcePayload,
} from "@/lib/contracts/source-fields";
import { sourceFieldRepository } from "@/lib/backend/repositories/source-fields";
import {
  projectPublicSourceFields,
  SourceFieldDataError,
} from "@/lib/backend/services/source-fields";
import { taskDraftSchema } from "@/lib/backend/validation/task-definitions";
import { taskInputSnapshotSchema } from "@/lib/backend/validation/input-snapshots";
import {
  resolveBoundBatchBlocks,
  resolveBoundInstructions,
  initialBoundAnswers,
  BindingResolutionError,
  hasSourceBindings,
} from "@/lib/frontend/source-binding";

/**
 * Derive one runtime definition using the same mapper as Builder previews.
 * Revalidate bound published manifests too: old passthrough drafts are not proof
 * of compatible targets. No raw source or client-supplied option is authoritative.
 */
export function resolveTaskInputs(
  definition: PublishedDefinitionData,
  snapshot: TaskInputSnapshot,
) {
  const { id, version, ...draft } = definition;
  const parsed = taskDraftSchema.safeParse(draft);
  if (!parsed.success)
    throw new BindingResolutionError(
      "Published binding configuration is invalid; revise and republish it.",
    );
  if (
    snapshot.batch &&
    (snapshot.batch[0].source.assetId !== snapshot.source.assetId ||
      snapshot.batch[0].source.sourceRecordId !==
        snapshot.source.sourceRecordId ||
      new Set(snapshot.batch.map((input) => input.source.assetId)).size !==
        snapshot.batch.length)
  )
    throw new BindingResolutionError(
      "Batch snapshot must begin with the primary source and contain distinct audio assets.",
    );
  const sources = (snapshot.batch ?? [snapshot]).map((input) => {
    if (
      input.id !== snapshot.id ||
      input.definitionId !== snapshot.definitionId ||
      input.definitionVersion !== snapshot.definitionVersion ||
      input.source.projectId !== snapshot.source.projectId
    )
      throw new BindingResolutionError("Batch snapshot identity mismatch.");
    const source: WorkerSourcePayload = {
      audioUrl: "",
      fields: [...(input.publicFields ?? [])],
    };
    if (input.question !== undefined)
      source.fields.push({
        field: SOURCE_FIELD_CATALOG[0],
        value: input.question,
      });
    if (input.choices !== undefined)
      source.fields.push({
        field: SOURCE_FIELD_CATALOG[1],
        value: input.choices,
      });
    // Only a published training block may consume a deliberately released
    // reference. Do not turn private labels into general worker source fields.
    for (const preview of input.trainingPreviews ?? []) {
      const block = parsed.data.blocks.find((b) => b.id === preview.blockId);
      if (
        block?.trainingAnswerPreview &&
        block.showSourceAnswer &&
        block.sourceBindings?.preview?.fieldId === preview.fieldId
      )
        source.fields.push({
          field: {
            id: preview.fieldId,
            type: "json",
            visibility: "worker",
            provenance: "source_labels",
          },
          value: preview.value,
        });
    }
    return source;
  });
  // Block's rich frontend settings are validated per type by taskDraftSchema;
  // the contract here is the existing renderer's Block, not untrusted request JSON.
  const blocks = resolveBoundBatchBlocks(
    parsed.data.blocks as Block[],
    sources,
  );
  return {
    definition: {
      ...definition,
      blocks,
      instructions: resolveBoundInstructions(
        definition.instructions,
        definition.instructionBinding,
        sources[0],
      ),
    },
    initialAnswers: initialBoundAnswers(blocks),
  };
}

/**
 * Capture only worker-safe fields of the exact linked source before insertion.
 * Snapshot insertion and audio-slot rows share the Task Instance transaction.
 * Source imports may change later; no subsequent read re-resolves live data.
 */
export async function captureTaskInputs(
  db: D1Database,
  identity: {
    id: string;
    projectId: string;
    datasetId: string;
    assetId: string;
    sourceRecordId: string;
    recordId: string;
  },
  definition: PublishedDefinitionData,
  deferResolution = false,
): Promise<TaskInputSnapshot> {
  const rows = await sourceFieldRepository.find(
    db,
    identity.projectId,
    identity.datasetId,
    identity.recordId,
    identity.assetId,
  );
  const row = rows[0];
  if (rows.length !== 1 || row.id !== identity.sourceRecordId)
    throw new BindingResolutionError(
      "The bound source does not match this task's project, dataset and recording.",
    );
  let publicSource: WorkerSourcePayload;
  try {
    publicSource = projectPublicSourceFields(row);
  } catch (error) {
    if (error instanceof SourceFieldDataError)
      throw new BindingResolutionError(
        "Bound source fields contain malformed data.",
      );
    throw error;
  }
  if (
    row.choicesJson !== null &&
    !publicSource.fields.some((field) => field.field.id === "choices") &&
    definition.blocks.some(
      (block) => (block.sourceBindings as Block["sourceBindings"])?.options,
    )
  )
    throw new BindingResolutionError(
      "Dataset choices are malformed; expected 2–50 nonblank text options.",
    );
  const question = publicSource.fields.find(
    (field) => field.field.id === "question",
  )?.value;
  const choices = publicSource.fields.find(
    (field) => field.field.id === "choices",
  )?.value;
  const snapshot: TaskInputSnapshot = {
    schemaVersion: 1,
    id: identity.id,
    definitionId: definition.id,
    definitionVersion: definition.version,
    source: {
      kind: "dataset",
      projectId: identity.projectId,
      datasetId: row.datasetId,
      assetId: row.assetId,
      sourceRecordId: row.id,
      recordId: row.sourceRecordId,
      sourceUpdatedAt: row.updatedAt,
    },
    ...(row.canonicalJson ? { publicFields: publicSource.fields } : {}),
    ...(typeof question === "string" ? { question } : {}),
    ...(Array.isArray(choices) &&
    choices.every((value): value is string => typeof value === "string")
      ? { choices }
      : {}),
  };
  const training = definition.blocks.filter(
    (b) =>
      b.trainingAnswerPreview === true &&
      b.showSourceAnswer === true &&
      (b.sourceBindings as Block["sourceBindings"])?.preview?.fieldId ===
        "reference_answer",
  );
  if (training.length) {
    // The enclosing creation service authorizes an administrator and checks
    // every source's project/dataset ownership before capture. Never mutate
    // source visibility or release early annotations/arbitrary metadata.
    const labels = (await sourceFieldRepository.labels(db, row.id)).filter(
      (l) => l.kind === "reference_answer",
    );
    if (labels.length !== 1)
      throw new BindingResolutionError(
        "Training preview requires exactly one original reference answer.",
      );
    let value: unknown;
    try {
      value = originalChoiceValue(JSON.parse(labels[0].payloadJson));
    } catch {
      throw new BindingResolutionError(
        "Original reference answer is malformed.",
      );
    }
    if (value === null)
      throw new BindingResolutionError(
        "Training preview supports only a text choice answer or an array of text choices.",
      );
    snapshot.trainingPreviews = training.map((b) => ({
      blockId: b.id,
      fieldId: "reference_answer",
      value,
    }));
  }
  // Resolve now, before the job exists, so missing required inputs cannot launch
  // an impossible assignment. Private labels never fill missing public inputs;
  // the explicit training release above is the sole reference-preview path.
  if (!deferResolution) resolveTaskInputs(definition, snapshot);
  return snapshot;
}

/** Parse persisted public inputs without leaking malformed JSON into logs. */
export function parseTaskInputs(raw: string): TaskInputSnapshot {
  try {
    return taskInputSnapshotSchema.parse(JSON.parse(raw));
  } catch {
    throw new BindingResolutionError("Stored task input snapshot is invalid.");
  }
}

/**
 * Use an explicit per-asset record ID, or auto-select only a unique stored record.
 * Callers must first verify the asset's project/dataset. Refuse zero/multiple
 * matches instead of taking the first question and potentially labelling the
 * wrong item. Shared by normal creation and the existing audio-queue shortcut.
 */
export async function selectTaskRecordId(
  db: D1Database,
  assetId: string,
  blocks: Array<{ id: string; sourceBindings?: unknown }>,
  requested?: string,
): Promise<string | undefined> {
  if (requested !== undefined || !hasSourceBindings(blocks)) return requested;
  const rows = await db
    .prepare(
      `SELECT source_record_id AS recordId
    FROM source_records WHERE asset_id=? ORDER BY id LIMIT 2`,
    )
    .bind(assetId)
    .all<{ recordId: string }>();
  if (rows.results.length !== 1)
    throw new BindingResolutionError(
      "Dataset-bound tasks need exactly one source record, or an explicit sourceRecordId for this recording.",
    );
  return rows.results[0].recordId;
}
