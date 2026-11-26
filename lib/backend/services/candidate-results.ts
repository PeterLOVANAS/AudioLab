import type { CandidateResult } from "@/lib/contracts/candidate-sets";
import { candidateSetRepository as sets } from "@/lib/backend/repositories/candidate-sets";
import { candidateResultRepository as results } from "@/lib/backend/repositories/candidate-results";
import { CandidateSetError } from "@/lib/backend/services/candidate-sets";
import { candidateValueSchema } from "@/lib/backend/validation/candidate-sets";

function object(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
function json(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CandidateSetError(422, "Stored voting data is malformed.");
  }
}

export const candidateResultService = {
  /**
   * Resolve an admin-scoped candidate set using eligible final revisions only.
   * Drafts never count. Each actor contributes at most one effective vote; a
   * corrupt duplicate actor is an error, never a second independent submission.
   * A strict majority (> half), not merely a plurality, is required after the
   * pinned minimum. Ties/no majority stay unresolved. Result events preserve
   * exact revision IDs, source identity, policy version and observed counts.
   *
   * finalize=false is read-only. Finalization persists at a guarded SQL watermark;
   * concurrent submissions force a retry, while accepted results are terminal
   * and share an atomic boundary with the closed-vote INSERT trigger.
   */
  async resolve(
    db: D1Database,
    projectId: string,
    userId: string,
    setId: string,
    finalize: boolean,
  ): Promise<CandidateResult> {
    if ((await sets.role(db, projectId, userId)) !== "admin")
      throw new CandidateSetError(403, "Project admin membership is required.");
    const set = await sets.byId(db, setId);
    const target = set ? await sets.target(db, set.taskInstanceId) : null;
    if (
      !set ||
      !target ||
      target.projectId !== projectId ||
      target.assetProjectId !== projectId ||
      target.definitionProjectId !== projectId
    )
      throw new CandidateSetError(
        404,
        "Candidate set not found in this project.",
      );
    const accepted = await results.accepted(db, setId);
    if (accepted) return accepted;
    const definition = object(json(target.definitionJson));
    if (
      Array.isArray(definition.blocks) &&
      definition.blocks
        .map(object)
        .filter(
          (b) => b.type === "candidate_vote" && b.candidateSource === "set",
        ).length !== 1
    )
      throw new CandidateSetError(
        422,
        "Resolve separate ballots in separate voting jobs.",
      );
    const block = Array.isArray(definition.blocks)
      ? definition.blocks.map(object).find((b) => b.id === set.blockId)
      : undefined;
    if (
      !block ||
      block.type !== "candidate_vote" ||
      block.candidateSource !== "set"
    )
      throw new CandidateSetError(422, "Invalid voting block.");
    const minimum =
      block.minimumVotes ??
      object(definition.policy).requiredIndependentVotes ??
      1;
    if (
      typeof minimum !== "number" ||
      !Number.isInteger(minimum) ||
      minimum < 1 ||
      minimum > 1000
    )
      throw new CandidateSetError(422, "Invalid minimum vote policy.");
    const [allEntries, rows] = await Promise.all([
      sets.entries(db, target.id),
      results.votes(db, target.id, set.blockId),
    ]);
    const entries = allEntries.filter((e) => e.candidateSetId === set.id);
    if (entries.length !== set.entryCount)
      throw new CandidateSetError(422, "Candidate snapshot is incomplete.");
    const counts: Record<string, number> = Object.create(null);
    for (const entry of entries) counts[entry.id] = 0;
    const votes: CandidateResult["votes"] = [];
    const excluded: string[] = [];
    const actors = new Set<string>();
    let watermark = 0;
    for (const row of rows) {
      watermark = Math.max(watermark, row.sequence);
      const vote = row.voteJson ? object(json(row.voteJson)) : {};
      const entry = entries.find((e) => e.id === vote.selectedCandidateId);
      if (
        row.projectId !== projectId ||
        row.actorId !== row.assignedActor ||
        !entry ||
        vote.candidateSetSnapshotId !== set.id ||
        (set.allowSelfVote === 0 && entry.sourceAuthorId === row.actorId) ||
        Object.keys(vote).some(
          (key) =>
            !["selectedCandidateId", "candidateSetSnapshotId"].includes(key),
        )
      ) {
        excluded.push(row.id);
        continue;
      }
      if (actors.has(row.actorId))
        throw new CandidateSetError(
          422,
          "Multiple final votes for the same worker require review.",
        );
      actors.add(row.actorId);
      counts[entry.id]++;
      votes.push({
        assignmentId: row.assignmentId,
        annotationRevisionId: row.id,
        actorId: row.actorId,
        candidateId: entry.id,
      });
    }
    const existing = await results.atWatermark(db, set.id, watermark);
    if (existing) return existing;
    const winner = entries.find((e) => counts[e.id] > votes.length / 2);
    const status =
      votes.length < minimum
        ? "pending_votes"
        : winner
          ? "accepted"
          : "pending_adjudication";
    const result: CandidateResult = {
      id: crypto.randomUUID(),
      persisted: finalize,
      candidateSetSnapshotId: set.id,
      taskInstanceId: target.id,
      blockId: set.blockId,
      definitionId: target.definitionId,
      definitionVersion: target.definitionVersion,
      status,
      policy: { version: 1, rule: "strict_majority", minimumVotes: minimum },
      totalVotes: votes.length,
      counts,
      votes,
      excludedRevisionIds: excluded,
    };
    if (status === "accepted" && winner) {
      result.accepted = {
        candidateId: winner.id,
        value: candidateValueSchema.parse(json(winner.valueJson)),
        source: {
          kind: winner.sourceKind,
          labelId: winner.sourceLabelId,
          revisionId: winner.sourceRevisionId,
          curatedCandidateId: winner.curatedCandidateId,
          fieldId: winner.sourceFieldId,
          taskInstanceId: winner.sourceTaskInstanceId,
          definitionId: winner.sourceDefinitionId,
          definitionVersion: winner.sourceDefinitionVersion,
          sourceRecordId: winner.sourceRecordDbId,
          observedAt: winner.sourceUpdatedAt,
        },
      };
    }
    if (!finalize) return result;
    if (await results.insert(db, result, watermark)) return result;
    const concurrent =
      (await results.accepted(db, set.id)) ??
      (await results.atWatermark(db, set.id, watermark));
    if (concurrent) return concurrent;
    throw new CandidateSetError(
      409,
      "Votes changed while calculating the result. Refresh and resolve again.",
    );
  },
};
