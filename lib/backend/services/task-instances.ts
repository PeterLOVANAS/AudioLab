/**
 * Task Instances — SERVICE (business rules).
 *
 * A Definition answers WHAT to annotate; an Asset answers WHICH recording;
 * an Instance is the relationship between them. It is not an assignment and
 * never stores human answers or imported reference answers.
 *
 * HTTP route -> validation -> this service -> repository -> D1.
 */
import type { CreateTaskInstanceInput } from "@/lib/backend/validation/task-instances";
import type {
  TaskInstancePreview,
  PublishedDefinitionData,
} from "@/lib/contracts/task-instances";
import {
  taskInstanceRepository as repo,
  type TaskInstanceRow,
} from "@/lib/backend/repositories/task-instances";

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
    // Null means this task was created as audio-only, not from MMAU QA.
    sourceRecord:
      row.sourceRecordId === null
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
   *
   * Why these checks in addition to SQLite foreign keys?
   * FKs can prove that A and B exist; they don't automatically prove that
   * the recording's dataset and the definition share the SAME project.
   */
  async create(db: D1Database, input: CreateTaskInstanceInput) {
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
    const requiredAssets = Math.max(
      1,
      ...snapshotDefinition.blocks.map((b) =>
        b.type === "ranking" && b.rankingMode !== "labels"
          ? Math.max(1, b.stimulusSlots?.length ?? 0)
          : (b.numBatch ?? 1),
      ),
    );
    const provided = input.audioAssetIds?.length ?? 1;
    if (requiredAssets > provided)
      throw new TaskInstanceProjectMismatchError(
        `Published task requires ${requiredAssets} recordings, only ${provided} provided.`,
      );

    let sourceRecordDbId: string | null = null;
    if (input.sourceRecordId !== undefined) {
      const source = await repo.sourceRow(
        db,
        input.assetId,
        input.sourceRecordId,
      );
      if (!source) {
        throw new TaskInstanceRelatedNotFoundError(
          "The source question does not belong to this audio asset.",
        );
      }
      sourceRecordDbId = source.id;
    }

    // Two independent source questions attached to ONE recording may be
    // different tasks. A stable key makes retried creation detectable.
    const instanceKey =
      input.sourceRecordId === undefined
        ? "audio"
        : `source:${input.sourceRecordId}`;

    const id = crypto.randomUUID();
    const inserted = await repo.insert(db, {
      id,
      projectId: input.projectId,
      definitionId: input.definitionId,
      definitionVersion: input.definitionVersion,
      assetId: input.assetId,
      sourceRecordDbId,
      instanceKey,
      audioAssetIds: input.audioAssetIds,
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
        `SELECT asset_id AS id,slot_index AS position
      FROM task_instance_audio_slots WHERE task_instance_id=? ORDER BY slot_index`,
      )
      .bind(id)
      .all<{ id: string; position: number }>();
    const audioAssets = (
      assets.results.length
        ? assets.results
        : [{ id: row.assetId, position: 0 }]
    ).map((a) => ({ ...a, url: `/api/v1/assets/${a.id}/audio` }));
    const candidates = await db
      .prepare(
        `SELECT id,label,provenance
      FROM annotation_candidates WHERE asset_id=? ORDER BY created_at,id LIMIT 100`,
      )
      .bind(row.assetId)
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
