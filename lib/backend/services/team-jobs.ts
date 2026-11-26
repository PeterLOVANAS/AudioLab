import { taskBatchDefinition } from "@/lib/contracts/task-batch-definition";
import { requiredTaskRecordings, packTaskBatches } from "@/lib/contracts/task-batches";
import type {
  JobInput,
  JobPlan,
  JobSummary,
  WorkerProfile,
  Team,
} from "@/lib/contracts/team-jobs";
import type { AllocationItem } from "@/lib/contracts/assignment-allocation";
import { allocationRepository } from "@/lib/backend/repositories/assignment-allocation";
import { assignmentRepository } from "@/lib/backend/repositories/assignments";
import {
  taskInstanceService,
  TaskInstanceConflictError,
} from "./task-instances";
import { taskDefinitionService } from "./task-definitions";
import { captureTaskInputs, resolveTaskInputs } from "./task-inputs";
import { hasSourceBindings } from "@/lib/frontend/source-binding";
import {
  digest,
  requireProjectAdmin,
  AuthError,
} from "@/lib/backend/auth/identity";
import type { PublishedDefinitionData } from "@/lib/contracts/task-instances";

/** Read typed project profiles. Membership eligibility is joined server-side;
 * a profession/country match can never grant the labeller permission itself.
 */
export async function workerProfiles(
  db: D1Database,
  project: string,
): Promise<WorkerProfile[]> {
  const rows = (
    await db
      .prepare(
        `SELECT m.user_id AS userId,m.display_name AS displayName,
 COALESCE(p.country,'') AS country,COALESCE(p.profession,'') AS profession,COALESCE(p.languages_json,'[]') AS languages,
 COALESCE(account.active,0) AS accountReady,COALESCE(p.experience_years,0) AS experienceYears,COALESCE(p.active,1) AS active,COALESCE(p.metadata_json,'{}') AS metadata
 FROM project_members m LEFT JOIN worker_profiles p ON p.project_id=m.project_id AND p.user_id=m.user_id
 LEFT JOIN auth_accounts account ON account.user_id=m.user_id
 WHERE m.project_id=? AND m.role='labeller' ORDER BY m.display_name,m.user_id LIMIT 200`,
      )
      .bind(project)
      .all<
        Omit<
          WorkerProfile,
          "languages" | "metadata" | "active" | "accountReady"
        > & {
          languages: string;
          metadata: string;
          active: number;
          accountReady: number;
        }
      >()
  ).results;
  return rows.map((row) => ({
    ...row,
    languages: JSON.parse(row.languages),
    metadata: JSON.parse(row.metadata),
    active: !!row.active,
    accountReady: !!row.accountReady,
  }));
}
export async function teams(db: D1Database, project: string): Promise<Team[]> {
  const rows = (
    await db
      .prepare(
        `SELECT t.id,t.name,m.user_id AS userId FROM worker_teams t
 LEFT JOIN worker_team_members m ON m.team_id=t.id WHERE t.project_id=? ORDER BY t.name,m.user_id`,
      )
      .bind(project)
      .all<{ id: string; name: string; userId: string | null }>()
  ).results;
  return [...new Set(rows.map((row) => row.id))].map((id) => ({
    id,
    name: rows.find((row) => row.id === id)!.name,
    memberIds: rows
      .filter((row) => row.id === id && row.userId)
      .map((row) => row.userId!),
  }));
}
/** Stable hash ordering makes the random partition reviewable and retryable.
 * Individual mode partitions every sampled item once; voting gives precisely
 * the same sampled set to every selected independent worker.
 */
export async function buildJobPlan(
  db: D1Database,
  actor: string,
  input: JobInput,
): Promise<JobPlan> {
  await requireProjectAdmin(db, input.projectId, actor);
  const dataset = await db
    .prepare("SELECT project_id AS p FROM datasets WHERE id=?")
    .bind(input.datasetId)
    .first<{ p: string }>();
  if (dataset?.p !== input.projectId)
    throw new AuthError(422, "Dataset is outside the project.");
  const owner = await db
    .prepare("SELECT project_id AS p FROM task_definitions WHERE id=?")
    .bind(input.definitionId)
    .first<{ p: string }>();
  if (owner?.p !== input.projectId)
    throw new AuthError(422, "Task Definition is outside the project.");
  const { definition } = await taskDefinitionService.getPublished(
    db,
    input.definitionId,
    input.definitionVersion,
  );
  if (definition.blocks.some((block) => block.type === "candidate_vote"))
    throw new AuthError(
      422,
      "Voting team jobs use independent original annotation blocks; legacy ballot definitions cannot be launched as new team jobs.",
    );
  const recordingsPerTask=requiredTaskRecordings(definition.blocks);
  const profiles = await workerProfiles(db, input.projectId),
    workers = input.workerIds
      .slice()
      .sort()
      .map((id) => profiles.find((worker) => worker.userId === id));
  if (workers.some((worker) => !worker?.active || !worker.accountReady))
    throw new AuthError(
      422,
      "Selected workers must be active project labellers.",
    );
  let frozenTeamName: string | null = null;
  if (input.teamId) {
    const team = (await teams(db, input.projectId)).find(
      (t) => t.id === input.teamId,
    );
    if (!team || input.workerIds.some((id) => !team.memberIds.includes(id)))
      throw new AuthError(
        422,
        "Selected workers do not belong to this project team.",
      );
    frozenTeamName = team.name;
  }
  if (!input.useEntireDataset && input.sampleCount > input.itemKeys.length)
    throw new AuthError(
      422,
      "Requested sample count exceeds selected available items.",
    );
  const found=input.useEntireDataset
    ? await allocationRepository.allItems(db,input.projectId,input.datasetId)
    : await allocationRepository.items(db,input.projectId,input.datasetId,input.itemKeys);
  if(!found.length)throw new AuthError(422,"No dataset items available.");
  if(found.length>1000)throw new AuthError(422,"Entire-dataset jobs currently support at most 1000 source items. Use a smaller selection.");
  if(!input.useEntireDataset && found.length!==input.itemKeys.length)throw new AuthError(422,"Missing or cross-project source items.");
  const sampleCount=input.useEntireDataset?found.length:input.sampleCount;
  const taskCount=Math.ceil(sampleCount/recordingsPerTask);
  if(taskCount*(input.mode==="voting"?workers.length:1)>500)throw new AuthError(422,"Limit a launch to 500 worker assignments; reduce the sample or worker count.");
  const shuffled = await Promise.all(
    found.map(async (item) => ({
      item,
      hash: await digest(input.seed + ":item:" + item.key),
    })),
  );
  shuffled.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const items = shuffled.slice(0, sampleCount).map((row) => row.item);
  const groupedItems=packTaskBatches(items,recordingsPerTask);
  const batches=groupedItems.map(group=>({key:group[0].key,itemKeys:group.map(item=>item.key)}));
  const ordered = await Promise.all(
    (workers as WorkerProfile[]).map(async (worker) => ({
      worker,
      hash: await digest(input.seed + ":worker:" + worker.userId),
    })),
  );
  ordered.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const pairs = batches.flatMap((item, index) =>
    (input.mode === "voting" ? ordered : [ordered[index % ordered.length]]).map(
      ({ worker }) => ({ itemKey: item.key, labellerId: worker.userId }),
    ),
  );
  const bound =
    hasSourceBindings(definition.blocks) || !!definition.instructionBinding;
  for(const group of groupedItems){
    const effective=taskBatchDefinition(definition as PublishedDefinitionData,group.length);
    if(!bound)continue;
    const snapshots=[];
    for(const item of group){
      if(!item.sourceId||!item.recordId)throw new AuthError(422,"This definition requires source annotations for every selected item.");
      snapshots.push(await captureTaskInputs(db,{
        id:input.jobId,projectId:input.projectId,datasetId:input.datasetId,
        assetId:item.assetId,sourceRecordId:item.sourceId,recordId:item.recordId,
      },effective,true));
    }
    // Resolve the complete batch together, exactly as creation/submission does.
    // Single-slot resolution incorrectly rejects valid NUM_BATCH-bound blocks.
    const resolved=resolveTaskInputs(effective,{
      ...snapshots[0],...(snapshots.length>1?{batch:snapshots}:{}),
    }).definition;
    const question=resolved.blocks.find(block=>!["section","callout","audio_player"].includes(block.type));
    group.forEach((item,index)=>{
      const panel=Array.isArray(question?.batchBlocks)?question.batchBlocks[index] as {label?:string}:question;
      item.question=panel?.label??item.question;
    });
  }
  const normalized = {
    ...input,
    ...(input.useEntireDataset?{sampleCount,itemKeys:[]}:{}),
    itemKeys: input.useEntireDataset?[]:[...input.itemKeys].sort(),
    workerIds: [...input.workerIds].sort(),
  };
  const hash = await digest(
    JSON.stringify({
      input: normalized,
      items: items.map((item) => ({
        key: item.key,
        sourceVersion: item.sourceVersion,
      })),
      pairs,
      ...(recordingsPerTask>1?{batches,recordingsPerTask,batchPolicy:"flexible-v1" as const}:{}),
      workers,
      teamName: frozenTeamName,
    }),
  );
  const total = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM audio_assets a LEFT JOIN source_records s ON s.asset_id=a.id WHERE a.dataset_id=?",
    )
    .bind(input.datasetId)
    .first<{ n: number }>();
  return {
    teamName: frozenTeamName,
    datasetTotalItems: total?.n ?? items.length,
    input: normalized,
    ...(recordingsPerTask>1?{batches,recordingsPerTask,batchPolicy:"flexible-v1" as const}:{}),
    items,
    workers: workers as WorkerProfile[],
    pairs,
    counts: Object.fromEntries(
      input.workerIds.map((id) => [
        id,
        pairs.filter((pair) => pair.labellerId === id).length,
      ]),
    ),
    hash,
  };
}
/** Save an immutable team/item/worker snapshot, then launch actual worker jobs.
 * The job ID is an idempotency key. Retries reuse its frozen plan, and may not
 * substitute another seed/team/version. Existing standalone tasks are preserved.
 */
export async function launchJob(
  db: D1Database,
  actor: string,
  input: JobInput,
  expectedHash: string,
) {
  await requireProjectAdmin(db, input.projectId, actor);
  let row = await db
    .prepare(
      "SELECT project_id AS projectId,plan_json AS json,plan_hash AS hash,launched_at AS launchedAt,deleted_at AS deletedAt FROM annotation_jobs WHERE id=?",
    )
    .bind(input.jobId)
    .first<{
      projectId: string;
      json: string;
      hash: string;
      launchedAt: string | null;
      deletedAt?:string|null;
    }>();
  let plan: JobPlan;
  if (row) {
    if(row.deletedAt)throw new AuthError(410,"This job was deleted and cannot be relaunched.");
    if (row.projectId !== input.projectId || row.hash !== expectedHash)
      throw new AuthError(
        409,
        "Job ID already belongs to a different frozen plan.",
      );
    plan = JSON.parse(row.json);
    const normalized = {
      ...input,
      itemKeys: [...input.itemKeys].sort(),
      workerIds: [...input.workerIds].sort(),
    };
    if (JSON.stringify(normalized) !== JSON.stringify(plan.input))
      throw new AuthError(
        409,
        "Job configuration changed; use a new job ID and preview.",
      );
    if (row.launchedAt) return jobDetail(db, actor, input.jobId);
  } else {
    plan = await buildJobPlan(db, actor, input);
    if (plan.hash !== expectedHash)
      throw new AuthError(
        409,
        "Team/items changed after preview. Preview again.",
      );
    await db.batch([
      db
        .prepare(
          `INSERT INTO annotation_jobs(id,project_id,name,team_id,dataset_id,definition_id,definition_version,mode,seed,plan_json,plan_hash,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          input.jobId,
          input.projectId,
          input.name,
          input.teamId ?? null,
          input.datasetId,
          input.definitionId,
          input.definitionVersion,
          input.mode,
          input.seed,
          JSON.stringify(plan),
          plan.hash,
          actor,
        ),
      ...plan.items.map((item, index) =>
        db
          .prepare(
            `INSERT INTO annotation_job_items(job_id,item_key,asset_id,source_record_id,position) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM annotation_jobs WHERE id=? AND plan_hash=?) ON CONFLICT(job_id,item_key) DO NOTHING`,
          )
          .bind(
            input.jobId,
            item.key,
            item.assetId,
            item.sourceId,
            index,
            input.jobId,
            plan.hash,
          ),
      ),
      ...plan.workers.map((worker) =>
        db
          .prepare(
            `INSERT INTO annotation_job_workers(job_id,project_id,user_id,profile_json) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM annotation_jobs WHERE id=? AND plan_hash=?) ON CONFLICT(job_id,user_id) DO NOTHING`,
          )
          .bind(
            input.jobId,
            input.projectId,
            worker.userId,
            JSON.stringify(worker),
            input.jobId,
            plan.hash,
          ),
      ),
    ]);
    row = await db
      .prepare(
        "SELECT plan_hash AS hash,launched_at AS launchedAt FROM annotation_jobs WHERE id=?",
      )
      .bind(input.jobId)
      .first<{
        projectId: string;
        json: string;
        hash: string;
        launchedAt: string | null;
      }>();
    if (row?.hash !== plan.hash)
      throw new AuthError(409, "Concurrent launch used another configuration.");
  }
  const active = await workerProfiles(db, input.projectId);
  if (
    plan.workers.some(
      (worker) =>
        !active.some(
          (current) =>
            current.userId === worker.userId &&
            current.active &&
            current.accountReady,
        ),
    )
  )
    throw new AuthError(
      409,
      "A frozen worker is no longer eligible; job was not reassigned.",
    );
  const taskIds = new Map<string, string>();
  const taskBatches=plan.batches??plan.items.map(item=>({key:item.key,itemKeys:[item.key]}));
  for (const batch of taskBatches) {
    const members=batch.itemKeys.map(key=>plan.items.find(item=>item.key===key)!);
    const item=members[0];
    const key = `job:${input.jobId}:${item.recordId ? `source:${item.recordId}` : "audio"}`;
    let id = (
      await db
        .prepare(
          "SELECT id FROM task_instances WHERE definition_id=? AND definition_version=? AND asset_id=? AND instance_key=?",
        )
        .bind(input.definitionId, input.definitionVersion, item.assetId, key)
        .first<{ id: string }>()
    )?.id;
    if (!id)
      try {
        id = (
          await taskInstanceService.create(
            db,
            {
              projectId: input.projectId,
              definitionId: input.definitionId,
              definitionVersion: input.definitionVersion,
              assetId: item.assetId,
              ...(members.length>1?{audioAssetIds:members.map(item=>item.assetId),...(members.every(item=>item.recordId)?{sourceRecordIds:members.map(item=>item.recordId!)}:{})}:{}),
              ...(item.recordId ? { sourceRecordId: item.recordId } : {}),
            },
            input.jobId,
          )
        ).id;
      } catch (error) {
        if (!(error instanceof TaskInstanceConflictError)) throw error;
        id = (
          await db
            .prepare(
              "SELECT id FROM task_instances WHERE definition_id=? AND definition_version=? AND asset_id=? AND instance_key=?",
            )
            .bind(
              input.definitionId,
              input.definitionVersion,
              item.assetId,
              key,
            )
            .first<{ id: string }>()
        )?.id;
        if (!id) throw error;
      }
    taskIds.set(batch.key, id);
  }
  const statements: D1PreparedStatement[] = [];
  // Bound parameters per statement stay below D1's 100-variable limit. The full
  // assignment/link collection commits atomically; tasks can be safely reused.
  for (let offset = 0; offset < plan.pairs.length; offset += 20) {
    const chunk = plan.pairs.slice(offset, offset + 20);
    statements.push(
      db
        .prepare(
          `INSERT INTO assignments(id,project_id,task_instance_id,labeller_user_id) VALUES ${chunk.map(() => "(?,?,?,?)").join(",")} ON CONFLICT(task_instance_id,labeller_user_id) DO NOTHING`,
        )
        .bind(
          ...chunk.flatMap((pair) => [
            crypto.randomUUID(),
            input.projectId,
            taskIds.get(pair.itemKey)!,
            pair.labellerId,
          ]),
        ),
    );
    statements.push(
      db
        .prepare(
          `WITH selected(job_id,item_key,task_id,user_id) AS (VALUES ${chunk.map(() => "(?,?,?,?)").join(",")})
 INSERT INTO annotation_job_assignments(job_id,assignment_id,item_key) SELECT selected.job_id,a.id,selected.item_key
 FROM selected JOIN assignments a ON a.task_instance_id=selected.task_id AND a.labeller_user_id=selected.user_id WHERE 1
 ON CONFLICT(assignment_id) DO NOTHING`,
        )
        .bind(
          ...chunk.flatMap((pair) => [
            input.jobId,
            pair.itemKey,
            taskIds.get(pair.itemKey)!,
            pair.labellerId,
          ]),
        ),
    );
  }
  statements.push(
    db
      .prepare(
        "UPDATE annotation_jobs SET launched_at=COALESCE(launched_at,CURRENT_TIMESTAMP) WHERE id=?",
      )
      .bind(input.jobId),
  );
  await db.batch(statements);
  return jobDetail(db, actor, input.jobId);
}
/** Board counters distinguish unique fully-labelled source items from worker tasks.
 * A batch assignment is linked once using its primary item (existing FK contract).
 * Expand each source item through the immutable plan's batch membership when
 * counting completion, so one submitted 4-audio task covers four source items.
 * Plans predating batching have no `batches` property and retain singleton logic.
 */
export async function jobSummaries(
  db: D1Database,
  project: string,
  onlyId?: string,
  includeArchived=false,
): Promise<JobSummary[]> {
  return (
    await db
      .prepare(
        `SELECT j.id,j.project_id AS projectId,j.name,COALESCE(json_extract(j.plan_json,'$.teamName'),t.name) AS teamName,
 json_extract(v.definition_json,'$.name') AS definitionName,j.definition_version AS definitionVersion,j.mode,j.created_at AS createdAt,j.launched_at AS launchedAt,j.deleted_at AS deletedAt,
 (SELECT COUNT(*) FROM annotation_job_items x WHERE x.job_id=j.id) AS items,
 (SELECT COUNT(*) FROM annotation_job_workers x WHERE x.job_id=j.id) AS workers,
 (SELECT COUNT(*) FROM annotation_job_assignments x WHERE x.job_id=j.id) AS assignments,
 (SELECT COUNT(*) FROM annotation_job_assignments x JOIN assignments a ON a.id=x.assignment_id WHERE x.job_id=j.id AND a.status IN ('submitted','reviewed')) AS submitted,
 (SELECT COUNT(*) FROM annotation_job_items item WHERE item.job_id=j.id AND EXISTS(SELECT 1 FROM annotation_job_assignments x WHERE x.job_id=j.id AND x.item_key=COALESCE((SELECT json_extract(b.value,'$.itemKeys[0]') FROM json_each(j.plan_json,'$.batches') b WHERE EXISTS(SELECT 1 FROM json_each(b.value,'$.itemKeys') member WHERE member.value=item.item_key) LIMIT 1),item.item_key))
 AND (SELECT COUNT(*) FROM annotation_job_assignments x WHERE x.job_id=j.id AND x.item_key=COALESCE((SELECT json_extract(b.value,'$.itemKeys[0]') FROM json_each(j.plan_json,'$.batches') b WHERE EXISTS(SELECT 1 FROM json_each(b.value,'$.itemKeys') member WHERE member.value=item.item_key) LIMIT 1),item.item_key))=CASE WHEN j.mode='voting' THEN (SELECT COUNT(*) FROM annotation_job_workers w WHERE w.job_id=j.id) ELSE 1 END
 AND NOT EXISTS(SELECT 1 FROM annotation_job_assignments x JOIN assignments a ON a.id=x.assignment_id WHERE x.job_id=j.id AND x.item_key=COALESCE((SELECT json_extract(b.value,'$.itemKeys[0]') FROM json_each(j.plan_json,'$.batches') b WHERE EXISTS(SELECT 1 FROM json_each(b.value,'$.itemKeys') member WHERE member.value=item.item_key) LIMIT 1),item.item_key) AND a.status NOT IN ('submitted','reviewed'))) AS fullyLabelledItems
 FROM annotation_jobs j LEFT JOIN worker_teams t ON t.id=j.team_id JOIN task_definition_versions v ON v.definition_id=j.definition_id AND v.version=j.definition_version
 WHERE j.project_id=? AND (?=1 OR j.deleted_at IS NULL) AND (? IS NULL OR j.id=?) ORDER BY j.created_at DESC,j.id DESC LIMIT 100`,
      )
      .bind(project, includeArchived?1:0, onlyId ?? null, onlyId ?? null)
      .all<JobSummary>()
  ).results;
}
export async function jobDetail(db: D1Database, actor: string, id: string, includeArchived=false) {
  const row = await db
    .prepare(
      "SELECT project_id AS projectId,plan_json AS json FROM annotation_jobs WHERE id=? AND (?=1 OR deleted_at IS NULL)",
    )
    .bind(id,includeArchived?1:0)
    .first<{ projectId: string; json: string }>();
  if (!row) throw new AuthError(404, "Team job not found.");
  await requireProjectAdmin(db, row.projectId, actor);
  const plan = JSON.parse(row.json) as JobPlan;
  const assignments = (
    await db
      .prepare(
        `SELECT a.id,a.labeller_user_id AS userId,a.status,a.started_at AS startedAt,a.submitted_at AS submittedAt,x.item_key AS itemKey,
 i.asset_id AS assetId,r.id AS revisionId,r.revision,r.answers_json AS answersJson
 FROM annotation_job_assignments x JOIN assignments a ON a.id=x.assignment_id JOIN task_instances i ON i.id=a.task_instance_id
 LEFT JOIN annotation_revisions r ON r.assignment_id=a.id AND r.revision=(SELECT MAX(revision) FROM annotation_revisions WHERE assignment_id=a.id)
 WHERE x.job_id=? ORDER BY x.item_key,a.labeller_user_id`,
      )
      .bind(id)
      .all<{
        id: string;
        userId: string;
        status: string;
        startedAt: string | null;
        submittedAt: string | null;
        itemKey: string;
        assetId: string;
        revisionId: string | null;
        revision: number | null;
        answersJson: string | null;
      }>()
  ).results;
  const summary = (await jobSummaries(db, row.projectId, id, includeArchived)).find(
    (job) => job.id === id,
  )!;
  return {
    summary,
    plan,
    assignments: assignments.map(({ answersJson, ...a }) => ({
      ...a,
      itemKeys:plan.batches?.find(batch=>batch.key===a.itemKey)?.itemKeys??[a.itemKey],
      answers: answersJson
        ? (JSON.parse(answersJson) as Record<string, unknown>)
        : null,
    })),
    workerProgress: plan.workers.map((worker) => ({
      userId: worker.userId,
      displayName: worker.displayName,
      total: plan.pairs.filter((pair) => pair.labellerId === worker.userId)
        .length,
      submitted: assignments.filter(
        (a) =>
          a.userId === worker.userId &&
          ["submitted", "reviewed"].includes(a.status),
      ).length,
    })),
  };
}

/** Remove a job from active boards/queues without deleting source or research
 * history. Repeated deletion is idempotent; authority comes from the session.
 */
export async function deleteJob(db:D1Database,actor:string,projectId:string,id:string){
  const job=await db.prepare("SELECT project_id AS projectId FROM annotation_jobs WHERE id=?").bind(id).first<{projectId:string}>();
  if(!job)throw new AuthError(404,"Job not found.");
  if(job.projectId!==projectId)throw new AuthError(403,"Job belongs to another project.");
  await requireProjectAdmin(db,projectId,actor);
  await db.prepare("UPDATE annotation_jobs SET deleted_at=COALESCE(deleted_at,CURRENT_TIMESTAMP) WHERE id=?").bind(id).run();
  return {deleted:true,historyPreserved:true};
}
