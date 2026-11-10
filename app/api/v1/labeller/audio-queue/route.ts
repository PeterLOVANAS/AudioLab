/**
 * Labeller audio queue for the LOCAL pilot.
 *
 * A Task Definition says WHAT to annotate. An audio queue groups real asset
 * metadata from D1 into the number of recordings required by its PUBLISHED
 * version. This endpoint does NOT download R2 bytes and does NOT create
 * thousands of Task Instances simply because someone opened the page.
 *
 * Each queue group is deterministic (asset ID sort) so a refresh keeps the
 * same group identities for a stable dataset. Adding/removing assets can
 * change later group boundaries; for a production campaign, freeze the asset
 * selection as a batch/manifest before distributing it to Labellers.
 *
 * Development-only: client-supplied labeller IDs are NOT authentication.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  taskInstanceService,
  TaskInstanceConflictError,
  TaskInstanceProjectMismatchError,
  TaskInstanceRelatedNotFoundError,
} from "@/lib/backend/services/task-instances";
import {
  assignmentService,
  AssignmentConflictError,
  AssignmentRelatedNotFoundError,
  AssignmentRoleError,
} from "@/lib/backend/services/assignments";

type Block = {
  type: string;
  numBatch?: number;
  rankingMode?: string;
  stimulusSlots?: string[];
};
type Snapshot = { name?: string; blocks?: Block[] };
type DefinitionRow = { version: number; json: string };
type AssetRow = {
  id: string;
  originalPath: string;
  durationSeconds: number | null;
};
type ProgressRow = {
  assetId: string;
  assignmentId: string | null;
  status: string | null;
};
type Group = {
  key: string;
  assets: AssetRow[];
  assignmentId: string | null;
  status: "ready" | "assigned" | "in_progress" | "submitted" | "reviewed";
};

function requiredRecordings(snapshot: Snapshot): number {
  const counts = (snapshot.blocks ?? []).map((block) => {
    const n =
      block.type === "ranking" && block.rankingMode !== "labels"
        ? Math.max(block.numBatch ?? 1, block.stimulusSlots?.length ?? 1)
        : (block.numBatch ?? 1);
    return Number.isInteger(n) && n > 0 ? n : 1;
  });
  return Math.max(1, ...counts);
}

async function context(
  projectId: string,
  labellerId: string,
  datasetId: string,
  definitionId: string,
) {
  const member = await env.DB.prepare(
    "SELECT role FROM project_members WHERE project_id=? AND user_id=?",
  )
    .bind(projectId, labellerId)
    .first<{ role: string }>();
  if (member?.role !== "labeller")
    throw new HttpError(403, "Labeller does not belong to this project.");
  const dataset = await env.DB.prepare(
    "SELECT id FROM datasets WHERE id=? AND project_id=?",
  )
    .bind(datasetId, projectId)
    .first<{ id: string }>();
  if (!dataset) throw new HttpError(404, "Dataset not found in this project.");
  const owner = await env.DB.prepare(
    "SELECT id FROM task_definitions WHERE id=? AND project_id=?",
  )
    .bind(definitionId, projectId)
    .first<{ id: string }>();
  if (!owner)
    throw new HttpError(
      404,
      "Task Builder definition not found in this project.",
    );
  const published = await env.DB.prepare(
    `
    SELECT version,definition_json AS json FROM task_definition_versions
    WHERE definition_id=? ORDER BY version DESC LIMIT 1
  `,
  )
    .bind(definitionId)
    .first<DefinitionRow>();
  if (!published)
    throw new HttpError(
      409,
      "Publish this Builder task before annotating real audio.",
    );
  const snapshot: Snapshot = JSON.parse(published.json) as Snapshot;
  const required = requiredRecordings(snapshot);
  if (required > 24)
    throw new HttpError(
      409,
      "This task requires more than the supported 24 recordings.",
    );
  return { published, snapshot, required };
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const getSchema = z.object({
  projectId: z.uuid(),
  labellerId: z.string().trim().min(1).max(128),
  definitionId: z.uuid(),
  datasetId: z.uuid(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(12),
});
const postSchema = z.strictObject({
  projectId: z.uuid(),
  labellerId: z.string().trim().min(1).max(128),
  definitionId: z.uuid(),
  datasetId: z.uuid(),
  definitionVersion: z.number().int().min(1),
  assetIds: z.array(z.uuid()).min(1).max(24),
});
function reject(error: unknown) {
  if (error instanceof HttpError)
    return Response.json({ error: error.message }, { status: error.status });
  if (
    error instanceof TaskInstanceProjectMismatchError ||
    error instanceof TaskInstanceConflictError ||
    error instanceof AssignmentConflictError
  )
    return Response.json({ error: error.message }, { status: 409 });
  if (
    error instanceof TaskInstanceRelatedNotFoundError ||
    error instanceof AssignmentRelatedNotFoundError
  )
    return Response.json({ error: error.message }, { status: 404 });
  if (error instanceof AssignmentRoleError)
    return Response.json({ error: error.message }, { status: 403 });
  console.error("Labeller audio queue failed", error);
  return Response.json(
    { error: "Audio queue operation failed." },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  if (!import.meta.env.DEV)
    return Response.json(
      { error: "Authentication is not configured." },
      { status: 403 },
    );
  const input = getSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!input.success)
    return Response.json(
      { error: "Invalid queue parameters.", issues: input.error.issues },
      { status: 400 },
    );
  const { projectId, labellerId, definitionId, datasetId, cursor, limit } =
    input.data;
  try {
    const { published, snapshot, required } = await context(
      projectId,
      labellerId,
      datasetId,
      definitionId,
    );
    const rows = await env.DB.prepare(
      `
      SELECT id, original_path AS originalPath, duration_seconds AS durationSeconds
      FROM audio_assets WHERE dataset_id=? ${cursor ? "AND id > ?" : ""}
      ORDER BY id ASC LIMIT ?
    `,
    )
      .bind(
        ...(cursor
          ? [datasetId, cursor, limit * required + 1]
          : [datasetId, limit * required + 1]),
      )
      .all<AssetRow>();
    const assetRows = rows.results;
    const fullCount = Math.min(limit, Math.floor(assetRows.length / required));
    const groups: Group[] = Array.from({ length: fullCount }, (_, i) => {
      const assets = assetRows.slice(i * required, (i + 1) * required);
      return { key: assets[0].id, assets, assignmentId: null, status: "ready" };
    });
    if (groups.length) {
      // ONE status lookup for the whole page: no N+1 queries.
      const placeholders = groups.map(() => "?").join(",");
      const progress = await env.DB.prepare(
        `
        SELECT i.asset_id AS assetId, a.id AS assignmentId, a.status
        FROM task_instances i
        LEFT JOIN assignments a ON a.task_instance_id=i.id AND a.labeller_user_id=?
        WHERE i.definition_id=? AND i.definition_version=? AND i.instance_key='audio'
          AND i.asset_id IN (${placeholders})
      `,
      )
        .bind(
          labellerId,
          definitionId,
          published.version,
          ...groups.map((g) => g.key),
        )
        .all<ProgressRow>();
      const index = new Map(progress.results.map((row) => [row.assetId, row]));
      for (const group of groups) {
        const prior = index.get(group.key);
        if (prior?.assignmentId) {
          group.assignmentId = prior.assignmentId;
          group.status =
            prior.status === "assigned" ||
            prior.status === "in_progress" ||
            prior.status === "submitted" ||
            prior.status === "reviewed"
              ? prior.status
              : "ready";
        }
      }
    }
    const last = groups.at(-1)?.assets.at(-1)?.id;
    const hasMore = assetRows.length > limit * required;
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM audio_assets WHERE dataset_id=?",
    )
      .bind(datasetId)
      .first<{ total: number }>();
    return Response.json({
      definition: {
        id: definitionId,
        version: published.version,
        name: snapshot.name ?? "Untitled task",
      },
      requiredAudio: required,
      totalAudio: count?.total ?? 0,
      totalCompleteGroups: Math.floor((count?.total ?? 0) / required),
      remainderAudio: (count?.total ?? 0) % required,
      groups,
      hasMore,
      nextCursor: hasMore && last ? last : null,
    });
  } catch (error) {
    return reject(error);
  }
}

export async function POST(request: Request) {
  if (!import.meta.env.DEV)
    return Response.json(
      { error: "Authentication is not configured." },
      { status: 403 },
    );
  const input = postSchema.safeParse(await request.json().catch(() => null));
  if (!input.success)
    return Response.json(
      { error: "Invalid audio queue selection.", issues: input.error.issues },
      { status: 400 },
    );
  const {
    projectId,
    labellerId,
    definitionId,
    datasetId,
    definitionVersion,
    assetIds,
  } = input.data;
  try {
    const { published, required } = await context(
      projectId,
      labellerId,
      datasetId,
      definitionId,
    );
    if (published.version !== definitionVersion)
      throw new HttpError(409, "The task was republished. Refresh the queue.");
    if (assetIds.length !== required || new Set(assetIds).size !== required)
      throw new HttpError(
        400,
        `This template requires ${required} distinct audio assets.`,
      );
    // Verify ALL assets against the selected project/dataset, never only the first.
    const holders = assetIds.map(() => "?").join(",");
    const valid = await env.DB.prepare(
      `
      SELECT id FROM audio_assets WHERE dataset_id=? AND id IN (${holders})
    `,
    )
      .bind(datasetId, ...assetIds)
      .all<{ id: string }>();
    if (valid.results.length !== required)
      throw new HttpError(
        400,
        "One or more recordings are not in this dataset.",
      );
    const primary = assetIds[0];
    let instance = await env.DB.prepare(
      `
      SELECT id FROM task_instances
      WHERE definition_id=? AND definition_version=? AND asset_id=? AND instance_key='audio'
    `,
    )
      .bind(definitionId, definitionVersion, primary)
      .first<{ id: string }>();
    if (!instance) {
      try {
        const created = await taskInstanceService.create(env.DB, {
          projectId,
          definitionId,
          definitionVersion,
          assetId: primary,
          ...(required > 1 ? { audioAssetIds: assetIds } : {}),
        });
        instance = { id: created.id };
      } catch (error) {
        if (!(error instanceof TaskInstanceConflictError)) throw error;
        // Another tab may have created the same instance concurrently.
        instance = await env.DB.prepare(
          `
          SELECT id FROM task_instances
          WHERE definition_id=? AND definition_version=? AND asset_id=? AND instance_key='audio'
        `,
        )
          .bind(definitionId, definitionVersion, primary)
          .first<{ id: string }>();
        if (!instance)
          throw new HttpError(
            409,
            "The task was created concurrently; refresh and retry.",
          );
      }
    }
    if (required > 1) {
      const slots = (
        await env.DB.prepare(
          `SELECT asset_id AS id FROM task_instance_audio_slots
        WHERE task_instance_id=? ORDER BY slot_index`,
        )
          .bind(instance.id)
          .all<{ id: string }>()
      ).results;
      if (
        slots.length !== required ||
        slots.some((slot, i) => slot.id !== assetIds[i])
      )
        throw new HttpError(
          409,
          "This primary audio belongs to a different existing batch. Open that assignment or choose another dataset group.",
        );
    }
    let assignment = await env.DB.prepare(
      `
      SELECT id FROM assignments WHERE task_instance_id=? AND labeller_user_id=?
    `,
    )
      .bind(instance.id, labellerId)
      .first<{ id: string }>();
    if (!assignment) {
      try {
        const created = await assignmentService.create(env.DB, {
          projectId,
          taskInstanceId: instance.id,
          labellerId,
        });
        assignment = { id: created.id };
      } catch (error) {
        if (!(error instanceof AssignmentConflictError)) throw error;
        assignment = await env.DB.prepare(
          `
          SELECT id FROM assignments WHERE task_instance_id=? AND labeller_user_id=?
        `,
        )
          .bind(instance.id, labellerId)
          .first<{ id: string }>();
        if (!assignment)
          throw new HttpError(
            409,
            "Concurrent assignment creation; refresh and retry.",
          );
      }
    }
    return Response.json({
      assignment: await assignmentService.getSummary(env.DB, assignment.id),
    });
  } catch (error) {
    return reject(error);
  }
}
