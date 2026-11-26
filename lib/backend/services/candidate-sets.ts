import type { CandidateSetView, CandidateSelectionContext, CandidateValue, CandidateSourceOption } from "@/lib/contracts/candidate-sets";
import type { CreateCandidateSetInput } from "@/lib/backend/validation/candidate-sets";
import { candidateValueSchema } from "@/lib/backend/validation/candidate-sets";
import {
  candidateSetRepository as repo, type CandidateSetRow, type CandidateEntryRow,
} from "@/lib/backend/repositories/candidate-sets";
import { assignmentRepository } from "@/lib/backend/repositories/assignments";

/** Expected eligibility/permission/conflict errors map to HTTP without exposing source values. */
export class CandidateSetError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Never let JSON.parse echo private annotation contents in an exception or route log. */
function storedJson(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw new CandidateSetError(422, "Stored candidate source contains invalid JSON."); }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function content(value: unknown): CandidateValue {
  const parsed = candidateValueSchema.safeParse(value);
  if (!parsed.success) throw new CandidateSetError(422, "Candidate content must be a nonempty scalar or ordered text list; select an answer field, not metadata.");
  return parsed.data;
}

/** Canonical source identity rejects duplicate references and makes request retries deterministic. */
function sourceKey(source: CreateCandidateSetInput["sources"][number]): string {
  if (source.kind === "submission") return JSON.stringify([source.kind,source.revisionId,source.blockId]);
  if (source.kind === "dataset_annotation") return JSON.stringify([source.kind,source.labelId,source.field ?? "value"]);
  return JSON.stringify([source.kind,source.candidateId]);
}
function matchRetry(prior: CandidateSetRow, input: CreateCandidateSetInput, fingerprint: string) {
  if (prior.requestId !== input.requestId || prior.requestFingerprint !== fingerprint)
    throw new CandidateSetError(409, "This voting block already has an immutable candidate set; use a new task for different candidates.");
}

export const candidateSetService = {
  /**
   * Snapshot selected real sources for one published voting block. The caller's
   * persisted project role must be admin; production must derive identity from
   * a session. Dataset reference answers are NEVER eligible for blind voting.
   * Imported early annotations use an explicit answer field, not arbitrary JSON.
   * Submitted sources must match project, primary audio and exact source record.
   * W01/workflow item selection remains an orchestration concern, not client data.
   */
  async create(db: D1Database, input: CreateCandidateSetInput) {
    if (await repo.role(db,input.projectId,input.userId) !== "admin")
      throw new CandidateSetError(403, "Project admin membership is required.");
    const target = await repo.target(db,input.taskInstanceId);
    if (!target || target.projectId !== input.projectId)
      throw new CandidateSetError(404, "Voting task not found in this project.");
    if (target.assetProjectId !== input.projectId || target.definitionProjectId !== input.projectId || target.extraAudio ||
        (target.sourceRecordDbId !== null && target.sourceAssetId !== target.assetId))
      throw new CandidateSetError(422, "Candidate sets require one recording with consistent project ownership.");
    const definition = object(storedJson(target.definitionJson));
    const block = Array.isArray(definition.blocks)
      ? definition.blocks.map(object).find((value) => value.id === input.blockId) : undefined;
    if (block?.type !== "candidate_vote" || block.candidateSource !== "set")
      throw new CandidateSetError(422, "Choose a published candidate_vote block configured for set selection.");
    const origins = block.candidateOrigins;
    if (
      Array.isArray(origins) &&
      input.sources.some((source) => !origins.includes(source.kind))
    )
      throw new CandidateSetError(
        422,
        "Candidate source category is not allowed by this published block.",
      );
    const keys = input.sources.map(sourceKey);
    if (new Set(keys).size !== keys.length)
      throw new CandidateSetError(422, "Candidate sources must be distinct.");
    const canonical = JSON.stringify([input.userId, target.definitionId,target.definitionVersion,keys]);
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))))
      .map((byte) => byte.toString(16).padStart(2,"0")).join("");
    const prior = await repo.find(db,target.id,input.blockId);
    if (prior) {
      matchRetry(prior,input,fingerprint);
      return { created: false, candidateSet: prior };
    }

    // Three bounded bulk lookups avoid N+1 source reads. These private rows are
    // never returned to a voter: only the selected answer value is snapshotted.
    const [labels, revisions, curated] = await Promise.all([
      repo.labels(db,input.sources.flatMap((source) => source.kind === "dataset_annotation" ? [source.labelId] : [])),
      repo.submissions(db,input.sources.flatMap((source) => source.kind === "submission" ? [source.revisionId] : [])),
      repo.curated(db,input.sources.flatMap((source) => source.kind === "curated" ? [source.candidateId] : [])),
    ]);
    const set: CandidateSetRow = {
      id: crypto.randomUUID(), taskInstanceId: target.id, blockId: input.blockId,
      requestId: input.requestId, requestFingerprint: fingerprint, createdBy: input.userId, entryCount: input.sources.length,
      allowSelfVote: block.allowSelfVote === true ? 1 : 0,
    };
    const entries: CandidateEntryRow[] = input.sources.map((source, position) => {
      const entry: CandidateEntryRow = {
        id: crypto.randomUUID(), candidateSetId: set.id, position, sourceKind: source.kind,
        sourceLabelId: null, sourceRevisionId: null, curatedCandidateId: null,
        sourceFieldId: "value", sourceRecordDbId: null, sourceTaskInstanceId: null,
        sourceDefinitionId: null, sourceDefinitionVersion: null, sourceAuthorId: null,
        sourceUpdatedAt: "", valueJson: "",
      };
      if (source.kind === "dataset_annotation") {
        const row = labels.find((value) => value.id === source.labelId);
        if (!row || row.kind !== "early_annotation" || row.projectId !== target.projectId ||
            row.assetId !== target.assetId || !target.sourceRecordDbId || row.sourceRecordDbId !== target.sourceRecordDbId)
          throw new CandidateSetError(422, "Dataset candidate is unavailable or ineligible for this source record.");
        const payload = storedJson(row.payloadJson);
        const selected = source.field !== undefined || (payload && typeof payload === "object" && !Array.isArray(payload))
          ? object(payload)[source.field ?? "value"] : payload;
        Object.assign(entry, { sourceLabelId: row.id, sourceRecordDbId: row.sourceRecordDbId,
          sourceFieldId: source.field ?? "value", sourceUpdatedAt: row.updatedAt, valueJson: JSON.stringify(content(selected)) });
      } else if (source.kind === "submission") {
        const row = revisions.find((value) => value.id === source.revisionId);
        if (!row || row.status !== "submitted" || row.projectId !== target.projectId || row.assetId !== target.assetId ||
            row.sourceRecordDbId !== target.sourceRecordDbId || row.extraAudio || row.taskInstanceId === target.id)
          throw new CandidateSetError(422, "Submitted candidate is unavailable or belongs to a different item.");
        const manifest = object(storedJson(row.definitionJson));
        if (!Array.isArray(manifest.blocks) || !manifest.blocks.map(object).some((field) => field.id === source.blockId &&
            !["section","callout","audio_player","transcript_summary"].includes(String(field.type))))
          throw new CandidateSetError(422, "Candidate answer field does not exist in its source definition.");
        const answers = object(storedJson(row.answersJson));
        if (!Object.hasOwn(answers,source.blockId)) throw new CandidateSetError(422,"Source submission has no selected answer.");
        Object.assign(entry, { sourceRevisionId: row.id, sourceTaskInstanceId: row.taskInstanceId,
          sourceDefinitionId: row.definitionId, sourceDefinitionVersion: row.definitionVersion,
          sourceFieldId: source.blockId, sourceRecordDbId: row.sourceRecordDbId, sourceAuthorId: row.authorId,
          sourceUpdatedAt: row.createdAt, valueJson: JSON.stringify(content(answers[source.blockId])) });
      } else {
        const row = curated.find((value) => value.id === source.candidateId);
        if (!row || row.projectId !== target.projectId || row.assetId !== target.assetId)
          throw new CandidateSetError(422, "Curated candidate is unavailable for this recording.");
        Object.assign(entry, { curatedCandidateId: row.id, sourceFieldId: "label",
          sourceUpdatedAt: row.createdAt, valueJson: JSON.stringify(content(row.label)) });
      }
      return entry;
    });
    const created = await repo.insert(db,set,entries);
    if (!created) {
      const winner = await repo.find(db,target.id,input.blockId);
      if (!winner) throw new Error("Candidate set missing after concurrent insert.");
      matchRetry(winner,input,fingerprint);
      return { created: false, candidateSet: winner };
    }
    return { created: true, candidateSet: set };
  },

  /** Curate existing eligible answer fields without typing raw revision/label IDs. */
  async inventory(
    db: D1Database,
    projectId: string,
    userId: string,
    taskId: string,
    blockId: string,
  ) {
    if ((await repo.role(db, projectId, userId)) !== "admin")
      throw new CandidateSetError(403, "Project admin membership is required.");
    const target = await repo.target(db, taskId);
    if (
      !target ||
      target.projectId !== projectId ||
      target.assetProjectId !== projectId ||
      target.definitionProjectId !== projectId
    )
      throw new CandidateSetError(404, "Voting task not found in this project.");
    const manifest = object(storedJson(target.definitionJson));
    const block = Array.isArray(manifest.blocks)
      ? manifest.blocks.map(object).find((b) => b.id === blockId)
      : undefined;
    if (!block || block.candidateSource !== "set")
      throw new CandidateSetError(422, "Choose a set-selection block.");
    const origins = Array.isArray(block.candidateOrigins)
      ? block.candidateOrigins
      : ["dataset_annotation", "submission", "curated"];
    const rows = await repo.availableSources(db, target);
    const sources: CandidateSourceOption[] = [];
    const add = (
      source: CandidateSourceOption["source"],
      value: unknown,
      label: string,
    ) => {
      const parsed = candidateValueSchema.safeParse(value);
      if (parsed.success) sources.push({ source, value: parsed.data, label });
    };
    if (origins.includes("dataset_annotation"))
      for (const row of rows.labels) {
        const raw = storedJson(row.payloadJson);
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const field of [
            "value",
            "text",
            "transcript",
            "label",
            "sound_label",
          ] as const)
            if (Object.hasOwn(raw, field))
              add(
                { kind: "dataset_annotation", labelId: row.id, field },
                object(raw)[field],
                `Imported early annotation · ${field}`,
              );
        } else
          add(
            { kind: "dataset_annotation", labelId: row.id },
            raw,
            "Imported early annotation",
          );
      }
    if (origins.includes("submission"))
      for (const row of rows.revisions) {
        if (row.extraAudio) continue;
        const sourceManifest = object(storedJson(row.definitionJson));
        const answers = object(storedJson(row.answersJson));
        if (Array.isArray(sourceManifest.blocks))
          for (const field of sourceManifest.blocks.map(object))
            if (
              typeof field.id === "string" &&
              ![
                "section",
                "callout",
                "audio_player",
                "transcript_summary",
              ].includes(String(field.type)) &&
              Object.hasOwn(answers, field.id)
            )
              add(
                { kind: "submission", revisionId: row.id, blockId: field.id },
                answers[field.id],
                `Submitted ${String(field.label)} · ${row.id.slice(0, 8)}`,
              );
      }
    if (origins.includes("curated"))
      for (const row of rows.curated)
        add(
          { kind: "curated", candidateId: row.id },
          row.label,
          "Curated candidate",
        );
    return { sources, candidateSet: await repo.find(db, taskId, blockId) };
  },

  /**
   * Project only anonymous eligible content to the actual assignment owner.
   * Self-authored submissions are excluded unless the pinned definition allowed
   * them. Source actor IDs, revision/label IDs, metadata and other fields never
   * enter this DTO. Current project membership is checked even after allocation.
   * Returns the same eligibility context used by draft and submit validation.
   */
  async forAssignment(db: D1Database, assignmentId: string, userId: string) {
    const assignment = await assignmentRepository.find(db,assignmentId);
    if (!assignment) throw new CandidateSetError(404,"Assignment not found.");
    if (assignment.labellerId !== userId || await repo.role(db,assignment.projectId,userId) !== "labeller")
      throw new CandidateSetError(403,"This candidate context is not available to this worker.");
    const target = await repo.target(db,assignment.taskInstanceId);
    if (!target || target.projectId !== assignment.projectId || target.assetProjectId !== assignment.projectId ||
        target.definitionProjectId !== assignment.projectId)
      throw new CandidateSetError(403,"Assignment and candidate source scope do not match.");
    const [sets, entries, closed] = await Promise.all([
      repo.sets(db,assignment.taskInstanceId), repo.entries(db,assignment.taskInstanceId),
      repo.closed(db,assignment.taskInstanceId),
    ]);
    const views: Record<string,CandidateSetView> = Object.create(null);
    const context: CandidateSelectionContext = Object.create(null);
    for (const set of sets) {
      if (entries.filter((entry) => entry.candidateSetId === set.id).length !== set.entryCount)
        throw new CandidateSetError(422,"Candidate set snapshot is incomplete.");
      const eligible = entries.filter((entry) => entry.candidateSetId === set.id &&
        (set.allowSelfVote === 1 || entry.sourceAuthorId !== userId));
      const candidates = eligible.map((entry) => ({ id: entry.id, value: content(storedJson(entry.valueJson)) }));
      views[set.blockId] = { id: set.id, taskInstanceId: assignment.taskInstanceId, blockId: set.blockId, closed: closed.includes(set.id), candidates };
      context[set.blockId] = { id: set.id, candidateIds: candidates.map((entry) => entry.id) };
    }
    return { candidateSets: views, context };
  },
};
