/**
 * Task Instances — SERVICE (business rules).
 *
 * A Definition answers WHAT to annotate; an Asset answers WHICH recording;
 * an Instance is the relationship between them. It is not an assignment and
 * never stores human answers or imported reference answers.
 *
 * HTTP route -> validation -> this service -> repository -> D1.
 */
import { taskBatchDefinition, markGroundingTabs } from "@/lib/contracts/task-batch-definition";
import { requiredTaskRecordings } from "@/lib/contracts/task-batches";
import type { CreateTaskInstanceInput } from "@/lib/backend/validation/task-instances";
import type {
  TaskInstancePreview,
  PublishedDefinitionData,
} from "@/lib/contracts/task-instances";
import {
  taskInstanceRepository as repo,
  type TaskInstanceRow,
} from "@/lib/backend/repositories/task-instances";

import {
  hasSourceBindings,
  BindingResolutionError,
} from "@/lib/frontend/source-binding";
import {
  captureTaskInputs,
  parseTaskInputs,
  resolveTaskInputs,
  selectTaskRecordId,
} from "@/lib/backend/services/task-inputs";

/** Error classes let HTTP routes map domain failures to the correct status. */
export class TaskInstanceNotFoundError extends Error {}
export class TaskInstanceRelatedNotFoundError extends Error {}
export class TaskInstanceProjectMismatchError extends Error {}
export class TaskInstanceConflictError extends Error {}

/**
 * Convert a DB row into a task preview safe for the FRONTEND.
 * The published definition is JSON TEXT in D1; JSON.parse converts it into
 * a JavaScript object. This does NOT re-read the latest mutable draft.
 *
 * We deliberately do NOT join source_labels, so an MMAU answer or an
 * imported early annotation cannot leak through this response.
 */
function toPreview(row: TaskInstanceRow): TaskInstancePreview {
  const draft = JSON.parse(row.definitionJson) as Omit<
    PublishedDefinitionData,
    "id" | "version"
  >;
  return {
    id: row.id,
    projectId: row.projectId,
    assetId: row.assetId,
    originalPath: row.originalPath,
    audioUrl: `/api/v1/assets/${row.assetId}/audio`,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    definitionName: row.definitionName,
    // Snapshot contains name, instructions, blocks, policy and workspace.
    definition: {
      id: row.definitionId,
      version: row.definitionVersion,
      ...draft,
    },
    // Audio-only tasks have no source context; bound tasks supply snapshot context below.
    sourceRecord:
      // Bound jobs derive this panel from their immutable public snapshot below,
      // never from a newly imported (possibly malformed) live question/choice row.
      row.sourceRecordId === null || hasSourceBindings(draft.blocks)
        ? null
        : {
            sourceRecordId: row.sourceRecordId,
            question: row.sourceQuestion,
            choices:
              row.sourceChoicesJson === null
                ? null
                : (JSON.parse(row.sourceChoicesJson) as string[]),
          },
    createdAt: row.createdAt,
  };
}

export const taskInstanceService = {
  /**
   * Create one task after checking every relationship.
   * allocationJobId is an internal, validated namespace for independent repeat
   * campaigns; HTTP callers cannot supply it through the public request schema.
   *
   * Why these checks in addition to SQLite foreign keys?
   * FKs can prove that A and B exist; they don't automatically prove that
   * the recording's dataset and the definition share the SAME project.
   */
  async create(db: D1Database, input: CreateTaskInstanceInput, allocationJobId?:string) {
    if (!(await repo.projectExists(db, input.projectId))) {
      throw new TaskInstanceRelatedNotFoundError("Project not found.");
    }

    const definition = await repo.definitionProject(db, input.definitionId);
    if (!definition) {
      throw new TaskInstanceRelatedNotFoundError("Task definition not found.");
    }

    const asset = await repo.assetProject(db, input.assetId);
    if (!asset) {
      throw new TaskInstanceRelatedNotFoundError("Audio asset not found.");
    }

    if (
      definition.projectId !== input.projectId ||
      asset.projectId !== input.projectId
    ) {
      throw new TaskInstanceProjectMismatchError(
        "The definition and audio asset must belong to the same project.",
      );
    }

    if (input.audioAssetIds) {
      if (
        input.audioAssetIds[0] !== input.assetId ||
        new Set(input.audioAssetIds).size !== input.audioAssetIds.length
      )
        throw new TaskInstanceProjectMismatchError(
          "The batch must start with assetId and contain unique assets.",
        );
      // All recordings, not just the first, must belong to this project.
      for (const id of input.audioAssetIds) {
        const member = await repo.assetProject(db, id);
        if (!member || member.projectId !== input.projectId)
          throw new TaskInstanceProjectMismatchError(
            "Every batch audio must belong to the task project.",
          );
      }
    }
    // Publishing is required: never run a labelling task from a mutable draft.
    const published = await repo.publishedExists(
      db,
      input.definitionId,
      input.definitionVersion,
    );
    if (!published) {
      throw new TaskInstanceRelatedNotFoundError(
        "Requested published definition version not found.",
      );
    }
    // Enforce batch-size feasibility when creating the task. Failing here is
    // better than assigning an impossible protocol to a labeller and receiving
    // HTTP 422 only at submission time.
    const snapshot = await db
      .prepare(
        `SELECT definition_json AS json FROM task_definition_versions
      WHERE definition_id=? AND version=?`,
      )
      .bind(input.definitionId, input.definitionVersion)
      .first<{ json: string }>();
    const snapshotDefinition = JSON.parse(snapshot!.json) as {
      blocks: Array<{
        type: string;
        numBatch?: number;
        stimulusSlots?: string[];
        rankingMode?: string;
      }>;
    };
    const requiredAssets = requiredTaskRecordings(snapshotDefinition.blocks);
    const provided = input.audioAssetIds?.length ?? 1;
    const jobPlan=allocationJobId?await db.prepare("SELECT plan_json AS json FROM annotation_jobs WHERE id=? AND project_id=? AND definition_id=? AND definition_version=? AND deleted_at IS NULL").bind(allocationJobId,input.projectId,input.definitionId,input.definitionVersion).first<{json:string}>():null;
    const flexible=jobPlan && JSON.parse(jobPlan.json).batchPolicy==="flexible-v1";
    if (requiredAssets > provided && !flexible)
      throw new TaskInstanceProjectMismatchError(
        `Published task requires ${requiredAssets} recordings, only ${provided} provided.`,
      );

    const publishedData: PublishedDefinitionData = {
      id: input.definitionId,
      version: input.definitionVersion,
      ...JSON.parse(snapshot!.json),
    };
    const definitionData=flexible?taskBatchDefinition(publishedData,provided):publishedData;
    const recordId = await selectTaskRecordId(
      db,
      input.assetId,
      [
        ...definitionData.blocks,
        ...(definitionData.instructionBinding
          ? [
              {
                id: "instructions",
                sourceBindings: { label: definitionData.instructionBinding },
              },
            ]
          : []),
      ],
      input.sourceRecordId,
    );
    let sourceRecordDbId: string | null = null;
    if (recordId !== undefined) {
      const source = await repo.sourceRow(db, input.assetId, recordId);
      if (!source) {
        throw new TaskInstanceRelatedNotFoundError(
          "The source question does not belong to this audio asset.",
        );
      }
      sourceRecordDbId = source.id;
    }

    // Two independent source questions attached to ONE recording may be
    // different tasks. A stable key makes retried creation detectable.
    if(allocationJobId && !await db.prepare("SELECT id FROM annotation_jobs WHERE id=? AND project_id=? AND definition_id=? AND definition_version=?").bind(allocationJobId,input.projectId,input.definitionId,input.definitionVersion).first())
      throw new TaskInstanceProjectMismatchError("Job does not match the project and published definition.");
    const baseKey=recordId===undefined?"audio":`source:${recordId}`;
    const instanceKey=allocationJobId?`job:${allocationJobId}:${baseKey}`:baseKey;

    const id = crypto.randomUUID();
    let inputSnapshotJson: string | undefined;
    if (
      hasSourceBindings(definitionData.blocks) ||
      definitionData.instructionBinding
    ) {
      if (!sourceRecordDbId || recordId === undefined)
        throw new BindingResolutionError(
          "Dataset-bound tasks require an explicit sourceRecordId for this recording.",
        );
      const assets = input.audioAssetIds ?? [input.assetId];
      if (
        input.sourceRecordIds &&
        (input.sourceRecordIds.length !== assets.length ||
          input.sourceRecordIds[0] !== recordId)
      )
        throw new BindingResolutionError(
          "Ordered sourceRecordIds must match the audio batch and its primary record.",
        );
      const inputs = [];
      // Capture each slot's public projection before the atomic instance insert.
      // No slot can borrow choices or hidden reference data from another item.
      for (const [index, assetId] of assets.entries()) {
        const member = await repo.assetProject(db, assetId);
        const selected =
          index === 0
            ? recordId
            : await selectTaskRecordId(
                db,
                assetId,
                [{ id: "bound-slot", sourceBindings: { label: {} } }],
                input.sourceRecordIds?.[index],
              );
        const source =
          selected === undefined
            ? null
            : await repo.sourceRow(db, assetId, selected);
        if (!member || !source || !selected)
          throw new BindingResolutionError(
            "Each bound batch audio needs an unambiguous source record.",
          );
        inputs.push(
          await captureTaskInputs(
            db,
            {
              id,
              projectId: input.projectId,
              datasetId: member.datasetId,
              assetId,
              sourceRecordId: source.id,
              recordId: selected,
            },
            definitionData,
            true,
          ),
        );
      }
      const captured = {
        ...inputs[0],
        ...(inputs.length > 1 ? { batch: inputs } : {}),
      };
      resolveTaskInputs(definitionData, captured);
      inputSnapshotJson = JSON.stringify(captured);
    }
    const inserted = await repo.insert(db, {
      id,
      projectId: input.projectId,
      definitionId: input.definitionId,
      definitionVersion: input.definitionVersion,
      assetId: input.assetId,
      sourceRecordDbId,
      instanceKey,
      audioAssetIds: input.audioAssetIds,
      inputSnapshotJson,
    });

    if (!inserted) {
      throw new TaskInstanceConflictError(
        "This definition/version/audio/source combination already has a task instance.",
      );
    }
    return this.get(db, id);
  },

  /** Read a single task preview using the published snapshot and audio URL. */
  async get(db: D1Database, id: string) {
    const row = await repo.find(db, id);
    if (!row) throw new TaskInstanceNotFoundError("Task instance not found.");
    const preview = toPreview(row);
    // Existing tasks created before migration 0008 still have one primary WAV.
    const assets = await db
      .prepare(
        `SELECT a.id,s.slot_index AS position,a.duration_seconds AS durationSeconds,a.sample_rate AS sampleRate,a.channels
      FROM task_instance_audio_slots s JOIN audio_assets a ON a.id=s.asset_id WHERE s.task_instance_id=? ORDER BY s.slot_index`,
      )
      .bind(id)
      .all<{ id: string; position: number; durationSeconds: number | null; sampleRate: number | null; channels: number | null }>();
    const audioAssets = (
      assets.results.length
        ? assets.results
        : [await db.prepare("SELECT id,0 AS position,duration_seconds AS durationSeconds,sample_rate AS sampleRate,channels FROM audio_assets WHERE id=?").bind(row.assetId).first<{id:string;position:number;durationSeconds:number|null;sampleRate:number|null;channels:number|null}>()].filter((a): a is NonNullable<typeof a> => a !== null)
    ).map((a) => ({ ...a, url: `/api/v1/assets/${a.id}/audio` }));

    // The policy is pinned in the job plan, never inferred from today's draft.
    // Older mixed tasks retain their original answer shape for revision integrity.
    const jobId=row.instanceKey?.match(/^job:([0-9a-f-]{36}):/i)?.[1];
    const policy=jobId?await db.prepare("SELECT plan_json AS json FROM annotation_jobs WHERE id=? AND project_id=? AND definition_id=? AND definition_version=?").bind(jobId,row.projectId,row.definitionId,row.definitionVersion).first<{json:string}>():null;
    const flexible=policy && JSON.parse(policy.json).batchPolicy==="flexible-v1";
    const effective=flexible?taskBatchDefinition(preview.definition,audioAssets.length):preview.definition;
    if(flexible)preview.resolvedDefinition=markGroundingTabs(preview.definition,effective);

    if (
      hasSourceBindings(effective.blocks) ||
      effective.instructionBinding
    ) {
      if (!row.inputSnapshotJson)
        throw new BindingResolutionError(
          "This legacy bound task has no pinned input snapshot; use a new published version or review an explicit backfill.",
        );
      const inputs = parseTaskInputs(row.inputSnapshotJson);
      if (
        inputs.id !== row.id ||
        inputs.definitionId !== row.definitionId ||
        inputs.definitionVersion !== row.definitionVersion ||
        inputs.source.projectId !== row.projectId ||
        inputs.source.assetId !== row.assetId ||
        inputs.source.sourceRecordId !== row.sourceRecordDbId
      )
        throw new BindingResolutionError(
          "Task input snapshot identity does not match the assignment.",
        );
      const resolved = resolveTaskInputs(effective, inputs);
      preview.resolvedDefinition = flexible?markGroundingTabs(preview.definition,resolved.definition):resolved.definition;
      preview.initialAnswers = resolved.initialAnswers;
      preview.inputContext = {
        snapshotId: inputs.id,
        sourceKind: "dataset",
        prefilledBlockIds: Object.keys(resolved.initialAnswers),
      };
      // Keep the legacy context panel consistent with the pinned form, even
      // after an importer changes the live source_record's question or choices.
      preview.sourceRecord = {
        sourceRecordId: inputs.source.recordId,
        question: inputs.question ?? null,
        choices: inputs.choices ?? null,
      };
    }
    if (row.inputSnapshotJson) {
      const pinned = parseTaskInputs(row.inputSnapshotJson);
      if (
        pinned.batch &&
        (pinned.batch.length !== audioAssets.length ||
          pinned.batch.some(
            (entry, i) => entry.source.assetId !== audioAssets[i].id,
          ))
      )
        throw new BindingResolutionError(
          "Pinned batch sources do not match ordered audio slots.",
        );
    }
    const selectionOnly =
      preview.definition.blocks.some(
        (block) =>
          block.type === "candidate_vote" && block.candidateSource === "set",
      ) &&
      !preview.definition.blocks.some(
        (block) =>
          block.type === "candidate_vote" && block.candidateSource !== "set",
      );
    // New selection sets are exposed only through an owner-scoped assignment
    // endpoint. Do not leak unrelated live curated candidates beside them.
    const candidates = selectionOnly
      ? { results: [] }
      : await db
          .prepare(
            `SELECT id,label,provenance
      FROM annotation_candidates WHERE asset_id=? AND project_id=? ORDER BY created_at,id LIMIT 100`,
          )
          .bind(row.assetId, row.projectId)
          .all<{ id: string; label: string; provenance: string }>();
    return { ...preview, audioAssets, candidates: candidates.results };
  },

  /** List compact summaries for the Admin task-management screen. */
  async list(db: D1Database, projectId: string, datasetId?: string) {
    if (!(await repo.projectExists(db, projectId))) {
      throw new TaskInstanceRelatedNotFoundError("Project not found.");
    }
    // For a dataset filter, check ownership even if no task instances exist.
    if (datasetId) {
      const dataset = await db
        .prepare("SELECT project_id AS projectId FROM datasets WHERE id = ?")
        .bind(datasetId)
        .first<{ projectId: string }>();
      if (!dataset)
        throw new TaskInstanceRelatedNotFoundError("Dataset not found.");
      if (dataset.projectId !== projectId) {
        throw new TaskInstanceProjectMismatchError(
          "Dataset belongs to another project.",
        );
      }
    }
    return repo.list(db, projectId, datasetId);
  },
};
