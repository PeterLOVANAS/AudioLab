/**
 * C03: real publication/annotation services + repositories against disposable
 * SQLite, plus shared renderer SSR. No remote access or precious D1 state.
 * Run: node scripts/test_assigned_bindings.cjs (Node 22+ with node:sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ts = require('@typescript/typescript6');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audiolab-c03-test-'));
const filename = path.join(directory, 'bindings.sqlite');
let sqlite = new DatabaseSync(filename);
sqlite.exec('PRAGMA foreign_keys=ON');
for (const file of fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort())
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative).exports;
  const file = path.join(root, relative);
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const mod = { exports: {} };
  cache.set(relative, mod);
  new Function('require', 'module', 'exports', output)((name) => {
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@/') || name.startsWith('.')) {
      const resolved = name.startsWith('@/') ? name.slice(2) : path.relative(root, path.resolve(path.dirname(file), name));
      return load(resolved + (fs.existsSync(path.join(root, resolved + '.ts')) ? '.ts' : '.tsx'));
    }
    return require(name);
  }, mod, mod.exports);
  return mod.exports;
}
// Implements only the D1 methods used by these actual repositories. SQL and
// constraints/triggers are the repository's; the adapter does not emulate them.
const statement = (sql, args = []) => ({ sql, args,
  bind(...values) { return statement(sql, values); },
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
  async run() { return { meta: sqlite.prepare(sql).run(...args) }; },
});
const db = { prepare: statement, async batch(statements) {
  sqlite.exec('BEGIN');
  try {
    const result = [];
    for (const s of statements) result.push(await s.run());
    sqlite.exec('COMMIT'); return result;
  } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
} };
const { validateAnswers } = load('lib/backend/validation/annotation-answers.ts');
const { taskDraftSchema } = load('lib/backend/validation/task-definitions.ts');
const { taskDefinitionService: definitions, TaskDefinitionPublicationError } = load('lib/backend/services/task-definitions.ts');
const { taskInstanceService: instances } = load('lib/backend/services/task-instances.ts');
const { assignmentService: assignments } = load('lib/backend/services/assignments.ts');
const { annotationService: annotations, AnnotationAnswerError, AnnotationLabellerMismatchError, AnnotationConflictError } = load('lib/backend/services/annotations.ts');
const model = load('components/task-builder/model.ts');
const { BindingResolutionError, resolveBoundBlocks, startingAssignmentAnswers } = load('lib/frontend/source-binding.ts');
const BlockFields = load('components/workbench/BlockFields.tsx').default;
const project = crypto.randomUUID(), dataset = crypto.randomUUID();
const otherProject = crypto.randomUUID(), otherDataset = crypto.randomUUID();
const assets = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const text = { kind: 'dataset', fieldId: 'question', type: 'string' };
const choice = { id: 'choice', type: 'single_choice', label: 'Fallback question', required: true,
  options: [{ id: 'static-a', label: 'Static A' }, { id: 'static-b', label: 'Static B' }],
  sourceBindings: { label: text, options: { kind: 'dataset', fieldId: 'choices', type: 'string[]' } } };
const blocks = [choice,
  { id: 'reference', type: 'text', label: 'Reference task', required: false,
    sourceBindings: { value: { ...text, mode: 'reference' } } },
  { id: 'readonly', type: 'text', label: 'Read-only context', required: false,
    sourceBindings: { value: { ...text, mode: 'read_only' } } },
  { id: 'prefill', type: 'text', label: 'Correct the source text', required: true,
    sourceBindings: { value: { ...text, mode: 'prefill' } } },
];
const draft = { name: 'C03 regression', description: '', domain: 'sound', instructions: 'Read and annotate', blocks,
  policy: { requiredIndependentVotes: 1, blindToOthers: true, requiresReview: false } };
function render(task, answers) {
  return renderToStaticMarkup(React.createElement(BlockFields, {
    blocks: task.resolvedDefinition.blocks, answers, onChange() { throw Error('Rendering must not write'); },
  }));
}
(async () => {
  for (const [p, d] of [[project, dataset], [otherProject, otherDataset]]) {
    sqlite.prepare('INSERT INTO projects(id,name,slug) VALUES(?,?,?)').run(p, 'C03', p);
    sqlite.prepare('INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)').run(d, p, 'MMAU', '1');
  }
  for (const [index, asset] of assets.entries()) {
    sqlite.prepare("INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key) VALUES(?,?,?,'r2',?)")
      .run(asset, dataset, `${index}.wav`, `${index}.wav`);
    sqlite.prepare(`INSERT INTO source_records(id,asset_id,source_record_id,source_domain,question,choices_json,metadata_json)
      VALUES(?,?,?,'sound',?,?,?)`).run(asset + '::record', asset, 'record', `Question ${index + 1}`,
        JSON.stringify([`Choice ${index + 1}`, 'B', 'C', 'D']), '{"answer":"METADATA_SECRET"}');
    sqlite.prepare("INSERT INTO source_labels(id,source_record_id,kind,payload_json,provenance) VALUES(?,?,'reference_answer',?,'imported_source_answer')")
      .run(asset + '::answer', asset + '::record', '{"value":"GROUND_TRUTH_SECRET"}');
  }
  await assignments.addMember(db, { projectId: project, userId: 'worker', displayName: 'Worker', role: 'labeller' });
  assert(taskDraftSchema.safeParse(draft).success);
  // Bound choices now support multi-recording batches; only invalid bounds fail.
  assert(taskDraftSchema.safeParse({ ...draft, blocks: [{ ...choice, numBatch: 2 }] }).success);
  for (const patch of [
    { sourceBindings: { options: { kind: 'dataset', fieldId: 'question', type: 'string' } } },
    { sourceBindings: { label: { kind: 'dataset', fieldId: 'reference_answer', type: 'json' } } },
    { sourceBindings: { value: { ...text, mode: 'prefill' } } }, // choice is not text
    { numBatch: 0 }, { optionFollowUps: { 'static-a': [{ id: 'child', type: 'text', label: 'Child', required: true }] } },
  ]) assert.equal(taskDraftSchema.safeParse({ ...draft, blocks: [{ ...choice, ...patch }] }).success, false);
  assert.equal(taskDraftSchema.safeParse({ ...draft, blocks: [{ ...blocks[2], required: true }] }).success, false);
  assert.equal(taskDraftSchema.safeParse({ ...draft, blocks: [{ ...blocks[3], sourceBindings: { value: { ...text, mode: 'prefill', missingValuePolicy: 'use_default' } } }] }).success, false);
  const definition = await definitions.create(db, project, taskDraftSchema.parse(draft));
  await definitions.publish(db, definition.id, 1, 0);
  const tasks = [];
  const assigned = [];
  for (const index of [0, 1]) {
    // One unique record can be selected automatically, preserving both existing
    // Workspace creation paths. The explicit per-asset form works identically.
    const task = await instances.create(db, { projectId: project, definitionId: definition.id,
      definitionVersion: 1, assetId: assets[index], ...(index ? { sourceRecordId: 'record' } : {}) });
    tasks.push(task);
    const job = await assignments.create(db, { projectId: project, taskInstanceId: task.id, labellerId: 'worker' });
    assigned.push(job);
    assert.equal(task.definition.blocks[0].label, 'Fallback question'); // protocol unchanged
    assert.equal(task.resolvedDefinition.blocks[0].label, `Question ${index + 1}`);
    assert.deepEqual(task.resolvedDefinition.blocks[0].options.map(option => option.id),
      ['source-choice-1', 'source-choice-2', 'source-choice-3', 'source-choice-4']);
    assert.equal(task.resolvedDefinition.blocks[0].options[0].label, `Choice ${index + 1}`);
    assert.equal(task.resolvedDefinition.blocks[2].type, 'callout');
    assert.equal(task.initialAnswers.prefill, `Question ${index + 1}`);
    const initial = startingAssignmentAnswers(task, null);
    assert.equal(initial.prefill, `Question ${index + 1}`);
    assert.deepEqual(startingAssignmentAnswers(task, { answers: {} }), {});
    const markup = render(task, initial);
    assert(markup.includes(`Question ${index + 1}`) && markup.includes(`Choice ${index + 1}`));
    assert(markup.includes('Reference (dataset question)') && markup.includes('Read-only context'));
    assert(!markup.includes('GROUND_TRUTH_SECRET'));
    const serialized = JSON.stringify(task);
    for (const secret of ['GROUND_TRUTH_SECRET', 'METADATA_SECRET', 'reference_answer', 'labelProvenance'])
      assert(!serialized.includes(secret));
    const write = (answers, expectedRevision) => ({ labellerId: 'worker', expectedRevision, answers });
    await annotations.save(db, job.id, write({}, 0), 'draft');
    for (const bad of ['static-a', 'unknown'])
      await assert.rejects(annotations.save(db, job.id, write({ choice: bad }, 1), 'draft'), AnnotationAnswerError);
    await assert.rejects(annotations.save(db, job.id, write({ readonly: 'fake answer' }, 1), 'draft'), AnnotationAnswerError);
    const answers = { choice: 'source-choice-2', prefill: `Edited ${index + 1}` };
    await annotations.save(db, job.id, write(answers, 1), 'draft');
    assert.deepEqual((await annotations.current(db, job.id, 'worker')).current.answers, answers);
    await annotations.save(db, job.id, write(answers, 2), 'submitted');
  }
  console.log('PASS two assigned records: common renderer displays each question/options, modes/prefill, dynamic answers save/submit, invalid/static IDs and read-only answers rejected');

  const snapshotBefore = sqlite.prepare('SELECT input_snapshot_json FROM task_instances WHERE id=?').get(tasks[0].id).input_snapshot_json;
  const parsedSnapshot = JSON.parse(snapshotBefore);
  assert.equal(parsedSnapshot.source.sourceRecordId, assets[0] + '::record');
  assert.equal(parsedSnapshot.definitionVersion, 1);
  assert(!snapshotBefore.includes('SECRET'));
  // Import edits and later publications cannot reinterpret existing revisions.
  sqlite.prepare("UPDATE source_records SET question='Changed import', choices_json='[\"W\",\"X\",\"Y\",\"Z\"]' WHERE asset_id=?").run(assets[0]);
  await definitions.update(db, definition.id, 1, { ...draft, blocks: [{ ...choice, label: 'New draft' }] });
  await definitions.publish(db, definition.id, 2, 1);
  sqlite.close(); sqlite = new DatabaseSync(filename); sqlite.exec('PRAGMA foreign_keys=ON');
  const reopened = await instances.get(db, tasks[0].id);
  assert.equal(reopened.resolvedDefinition.blocks[0].label, 'Question 1');
  assert.equal(reopened.resolvedDefinition.blocks[0].options[0].label, 'Choice 1');
  assert.equal(reopened.sourceRecord.question, 'Question 1');
  sqlite.prepare('UPDATE source_records SET choices_json=? WHERE asset_id=?')
    .run('MALFORMED_CURRENT_IMPORT', assets[0]);
  assert.equal((await instances.get(db, tasks[0].id)).resolvedDefinition.blocks[0].options[0].label, 'Choice 1');
  const saved = (await annotations.current(db, assigned[0].id, 'worker')).current;
  assert.equal(saved.answers.choice, 'source-choice-2');
  assert(render(reopened, saved.answers).includes('Question 1'));
  assert.deepEqual((await annotations.history(db, assigned[0].id, 'worker')).map(row => row.revision), [1, 2, 3]);
  assert.throws(() => sqlite.prepare("UPDATE task_instances SET input_snapshot_json='{}' WHERE id=?").run(tasks[0].id), /TASK_INPUT_SNAPSHOT_IMMUTABLE/);
  assert.throws(() => sqlite.prepare('UPDATE task_instances SET asset_id=? WHERE id=?').run(assets[1], tasks[0].id), /TASK_BOUND_IDENTITY_IMMUTABLE/);
  console.log('PASS reopen exact inputs after import/definition changes; immutable snapshot and bound identity, historical revisions intact');

  // Fail closed for legacy jobs, missing/ambiguous data and malformed choices.
  const legacyId = crypto.randomUUID();
  sqlite.prepare(`INSERT INTO task_instances(id,project_id,definition_id,definition_version,asset_id,source_record_db_id,instance_key)
    VALUES(?,?,?,?,?,?,?)`).run(legacyId, project, definition.id, 1, assets[2], assets[2] + '::record', 'legacy');
  await assert.rejects(instances.get(db, legacyId), /no pinned input snapshot/);
  sqlite.prepare("UPDATE source_records SET choices_json='[\"A\",42,\"C\",\"D\"]' WHERE asset_id=?").run(assets[2]);
  await assert.rejects(instances.create(db, { projectId: project, definitionId: definition.id,
    definitionVersion: 1, assetId: assets[2], sourceRecordId: 'record' }), BindingResolutionError);
  sqlite.prepare("UPDATE source_records SET choices_json=NULL WHERE asset_id=?").run(assets[2]);
  await assert.rejects(instances.create(db, { projectId: project, definitionId: definition.id,
    definitionVersion: 1, assetId: assets[2], sourceRecordId: 'record' }), /unavailable/);
  sqlite.prepare(`INSERT INTO source_records(id,asset_id,source_record_id,source_domain) VALUES(?,?,?,'sound')`)
    .run('ambiguous', assets[2], 'second-record');
  await assert.rejects(instances.create(db, { projectId: project, definitionId: definition.id,
    definitionVersion: 1, assetId: assets[2] }), /exactly one source record/);

  // Missing-policy rules are shared by preview and runtime.
  const empty = { fields: [] };
  assert.throws(() => resolveBoundBlocks([choice], empty), /unavailable/);
  const fallback = resolveBoundBlocks([{ ...choice, sourceBindings: {
    label: { ...text, missingValuePolicy: 'use_default' },
    options: { ...choice.sourceBindings.options, missingValuePolicy: 'use_default' },
  } }], empty)[0];
  assert.equal(fallback.label, 'Fallback question');
  assert.equal(fallback.options[0].id, 'static-a');
  assert.equal(resolveBoundBlocks([{ ...blocks[1], sourceBindings: { value: { ...text, mode: 'reference', missingValuePolicy: 'empty' } } }], empty)[0].helpText,
    'Reference (dataset question): Unavailable');
  console.log('PASS legacy/missing/ambiguous/malformed data block explicitly; explicit missing policies retain static defaults only when requested');

  const staticDefinition = await definitions.create(db, project, { ...draft, blocks: [{ ...choice, sourceBindings: undefined }] });
  await definitions.publish(db, staticDefinition.id, 1, 0);
  const staticTask = await instances.create(db, { projectId: project, definitionId: staticDefinition.id,
    definitionVersion: 1, assetId: assets[0] });
  assert.equal(staticTask.resolvedDefinition, undefined);
  const staticJob = await assignments.create(db, { projectId: project, taskInstanceId: staticTask.id, labellerId: 'worker' });
  await annotations.save(db, staticJob.id, { labellerId: 'worker', expectedRevision: 0, answers: { choice: 'static-b' } }, 'submitted');
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);

  // W01 is independent: exercise both application orders without altering its SQL.
  // Byte-pinned by test_team_job_migrations; no cached remote ref is required.
  const w01 = fs.readFileSync(path.join(root, 'fixtures/migration-compatibility/w01-workflow.sql.fixture'), 'utf8');
  const c03 = fs.readFileSync(path.join(root, 'migrations/0011_task_input_snapshots.sql'), 'utf8');
  for (const pair of [[w01, c03], [c03, w01]]) {
    const combined = new DatabaseSync(':memory:'); combined.exec('PRAGMA foreign_keys=ON');
    for (const file of fs.readdirSync(path.join(root, 'migrations')).filter(file => /^000\d.*\.sql$/.test(file)).sort())
      combined.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
    for (const migration of pair) combined.exec(migration);
    assert.deepEqual(combined.prepare('PRAGMA foreign_key_check').all(), []);
    combined.close();
  }
  console.log('PASS static answers, foreign keys, migration 0011 before/after reserved W01 0010');
  console.log(`Disposable evidence DB: ${filename}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sqlite.close());
