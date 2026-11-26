import type {
  AllocationRequest,
  AllocationPair,
  AllocationPreview,
  AllocationItem,
} from "@/lib/contracts/assignment-allocation";
import { assignmentRepository } from "@/lib/backend/repositories/assignments";
import { allocationRepository as repo } from "@/lib/backend/repositories/assignment-allocation";
import {
  taskInstanceService,
  TaskInstanceConflictError,
} from "@/lib/backend/services/task-instances";
import {
  captureTaskInputs,
  resolveTaskInputs,
} from "@/lib/backend/services/task-inputs";
import {
  hasSourceBindings,
  BindingResolutionError,
} from "@/lib/frontend/source-binding";
import type { PublishedDefinitionData } from "@/lib/contracts/task-instances";

/** Domain errors expose actionable validation without SQL or protected source values. */
export class AllocationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** Persisted admin membership complements the mandatory authenticated HTTP
 * boundary; a caller ID alone never establishes identity.
 */
export async function requireAllocationAdmin(
  db: D1Database,
  project: string,
  user: string,
) {
  if ((await assignmentRepository.member(db, project, user))?.role !== "admin")
    throw new AllocationError(
      403,
      "Select an existing local admin member of this project.",
    );
}
async function datasetScope(db: D1Database, project: string, dataset: string) {
  if (
    !(await db
      .prepare("SELECT id FROM datasets WHERE id=? AND project_id=?")
      .bind(dataset, project)
      .first())
  )
    throw new AllocationError(404, "Dataset does not belong to this project.");
}
/** Paginate item identities, never infer an item from its audio or display text. */
export async function allocationItems(
  db: D1Database,
  project: string,
  user: string,
  dataset: string,
  cursor = "",
) {
  await requireAllocationAdmin(db, project, user);
  await datasetScope(db, project, dataset);
  const rows = await repo.items(db, project, dataset, undefined, cursor),
    items = rows.slice(0, 100);
  return {
    items,
    hasMore: rows.length > 100,
    nextCursor: rows.length > 100 ? items.at(-1)!.key : null,
  };
}
async function context(db: D1Database, input: AllocationRequest) {
  await requireAllocationAdmin(db, input.projectId, input.adminId);
  await datasetScope(db, input.projectId, input.datasetId);
  const version = await db
    .prepare(
      `SELECT v.definition_json AS json FROM task_definition_versions v
    JOIN task_definitions d ON d.id=v.definition_id WHERE d.project_id=? AND d.id=? AND v.version=?`,
    )
    .bind(input.projectId, input.definitionId, input.definitionVersion)
    .first<{ json: string }>();
  if (!version)
    throw new AllocationError(
      404,
      "Choose a published Task Definition version in this project.",
    );
  const definition: PublishedDefinitionData = {
    ...JSON.parse(version.json),
    id: input.definitionId,
    version: input.definitionVersion,
  };
  if (
    definition.blocks.some(
      (block) =>
        (typeof block.numBatch === "number" && block.numBatch > 1) ||
        (block.type === "ranking" &&
          block.rankingMode !== "labels" &&
          Array.isArray(block.stimulusSlots) &&
          block.stimulusSlots.length > 1),
    )
  )
    throw new AllocationError(
      422,
      "This MVP allocates one source item/audio per task. Choose a NUM_BATCH=1 definition.",
    );
  if (
    input.independentLabellers > input.labellerIds.length ||
    (input.mode === "fixed" &&
      input.independentLabellers !== input.labellerIds.length)
  )
    throw new AllocationError(
      422,
      "Fixed panel requires exactly N selected workers; balanced allocation needs at least N eligible workers.",
    );
  if (input.itemKeys.length * input.independentLabellers > 500)
    throw new AllocationError(
      422,
      "Allocate at most 500 assignments per confirmation.",
    );
  const members = await assignmentRepository.listMembers(db, input.projectId);
  for (const id of input.labellerIds)
    if (
      !members.some(
        (member) => member.userId === id && member.role === "labeller",
      )
    )
      throw new AllocationError(
        422,
        `Worker ${id} is not an eligible project labeller.`,
      );
  const found = await repo.items(
    db,
    input.projectId,
    input.datasetId,
    input.itemKeys,
  );
  if (found.length !== input.itemKeys.length)
    throw new AllocationError(
      422,
      "One or more items are missing or outside the selected dataset/project.",
    );
  const items = input.itemKeys.map((key) =>
    found.find((item) => item.key === key)!,
  );
  const bound =
    hasSourceBindings(definition.blocks) || !!definition.instructionBinding;
  // Validate every dynamic input before creating any task or assignment. This
  // uses the existing public resolver; no client-supplied choices are accepted.
  for (const item of items)
    if (bound) {
      if (!item.sourceId || !item.recordId)
        throw new AllocationError(
          422,
          `${item.originalPath} has no source item required by the definition.`,
        );
      try {
        const pinned = await captureTaskInputs(
          db,
          {
            id: "allocation-preview",
            projectId: input.projectId,
            datasetId: input.datasetId,
            assetId: item.assetId,
            sourceRecordId: item.sourceId,
            recordId: item.recordId,
          },
          definition,
        );
        item.question =
          resolveTaskInputs(definition, pinned).definition.blocks.find(
            (block) =>
              ![
                "section",
                "callout",
                "audio_player",
                "transcript_summary",
              ].includes(block.type),
          )?.label ?? item.question;
      } catch (error) {
        if (error instanceof BindingResolutionError)
          throw new AllocationError(
            422,
            `${item.originalPath}: ${error.message}`,
          );
        throw error;
      }
    }
  return {
    items,
    members,
    existing: await repo.existing(
      db,
      input.projectId,
      input.definitionId,
      input.definitionVersion,
      input.itemKeys,
    ),
  };
}
/** Deterministic least-load allocation, counting only distinct workers per item.
 * Existing eligible assignments occupy seats first, so a new preview after a
 * successful confirmation proposes the same workers instead of creating N more.
 */
export async function previewAllocation(
  db: D1Database,
  input: AllocationRequest,
): Promise<AllocationPreview> {
  const { items, members, existing } = await context(db, input);
  const loads = new Map(
    (await repo.workloads(db, input.projectId)).map((row) => [
      row.userId,
      row.count,
    ]),
  );
  const pairs: AllocationPreview["pairs"] = [];
  for (const item of items) {
    let selected = input.labellerIds.slice();
    if (input.mode === "balanced") {
      selected = [
        ...new Set(
          existing
            .filter((pair) => pair.itemKey === item.key)
            .map((pair) => pair.labellerId),
        ),
      ];
      if (
        selected.length > input.independentLabellers ||
        selected.some((id) => !input.labellerIds.includes(id))
      )
        throw new AllocationError(
          409,
          "An item already has assignments outside this pool or above N. Keep its original pool/count or select other items.",
        );
      while (selected.length < input.independentLabellers) {
        const next = input.labellerIds
          .filter((id) => !selected.includes(id))
          .sort(
            (a, b) =>
              (loads.get(a) ?? 0) - (loads.get(b) ?? 0) || a.localeCompare(b),
          )[0];
        selected.push(next);
        loads.set(next, (loads.get(next) ?? 0) + 1);
      }
    }
    for (const id of selected)
      pairs.push({
        itemKey: item.key,
        labellerId: id,
        labellerName: members.find((m) => m.userId === id)!.displayName,
        existing: existing.some(
          (pair) => pair.itemKey === item.key && pair.labellerId === id,
        ),
      });
  }
  return {
    items,
    pairs,
    uniqueItems: items.length,
    assignments: pairs.length,
    newAssignments: pairs.filter((pair) => !pair.existing).length,
    perWorker: input.labellerIds.map((id) => ({
      userId: id,
      name: members.find((m) => m.userId === id)!.displayName,
      proposed: pairs.filter((pair) => pair.labellerId === id).length,
      existing: pairs.filter((pair) => pair.labellerId === id && pair.existing)
        .length,
    })),
  };
}
/** Revalidate the reviewed pairs, then atomically insert actual worker assignments.
 * Pair uniqueness is durable, independent of UI clicks or group membership.
 * Recover a concurrent Task Instance creation by its existing natural key.
 */
export async function confirmAllocation(
  db: D1Database,
  input: AllocationRequest,
  pairs: AllocationPair[],
) {
  const { items, existing } = await context(db, input);
  const seen = new Set<string>();
  for (const pair of pairs) {
    const key = JSON.stringify([pair.itemKey, pair.labellerId]);
    if (
      seen.has(key) ||
      !input.itemKeys.includes(pair.itemKey) ||
      !input.labellerIds.includes(pair.labellerId)
    )
      throw new AllocationError(
        422,
        "Confirmation contains duplicate, unselected or ineligible pairs.",
      );
    seen.add(key);
  }
  for (const item of items) {
    const workers = pairs
      .filter((pair) => pair.itemKey === item.key)
      .map((pair) => pair.labellerId);
    if (
      workers.length !== input.independentLabellers ||
      (input.mode === "fixed" &&
        workers.some((id) => !input.labellerIds.includes(id)))
    )
      throw new AllocationError(
        422,
        "Every item must have exactly N distinct eligible labellers.",
      );
    if (
      input.mode === "balanced" &&
      existing.some(
        (pair) =>
          pair.itemKey === item.key && !workers.includes(pair.labellerId),
      )
    )
      throw new AllocationError(
        409,
        "Existing allocation changed after preview; refresh before confirming.",
      );
  }
  const tasks = new Map<string, string>();
  for (const item of items) {
    let taskId = await findTask(db, input, item);
    if (!taskId)
      try {
        taskId = (
          await taskInstanceService.create(db, {
            projectId: input.projectId,
            definitionId: input.definitionId,
            definitionVersion: input.definitionVersion,
            assetId: item.assetId,
            ...(item.recordId ? { sourceRecordId: item.recordId } : {}),
          })
        ).id;
      } catch (error) {
        if (!(error instanceof TaskInstanceConflictError)) throw error;
        taskId = await findTask(db, input, item);
        if (!taskId) throw error;
      }
    const task = await taskInstanceService.get(db, taskId);
    if (task.audioAssets?.length !== 1)
      throw new AllocationError(
        409,
        "An existing task uses an incompatible audio bundle; choose another definition version.",
      );
    tasks.set(item.key, taskId);
  }
  const created = await repo.insert(
    db,
    input.projectId,
    pairs.map((pair) => ({
      taskId: tasks.get(pair.itemKey)!,
      labellerId: pair.labellerId,
    })),
  );
  return {
    uniqueItems: items.length,
    assignments: pairs.length,
    created,
    alreadyAssigned: pairs.length - created,
  };
}
async function findTask(
  db: D1Database,
  input: AllocationRequest,
  item: AllocationItem,
) {
  return (
    await db
      .prepare(
        `SELECT id FROM task_instances WHERE definition_id=? AND definition_version=? AND asset_id=? AND instance_key=?`,
      )
      .bind(
        input.definitionId,
        input.definitionVersion,
        item.assetId,
        item.recordId ? `source:${item.recordId}` : "audio",
      )
      .first<{ id: string }>()
  )?.id;
}
