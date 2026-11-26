/**
 * C01: real publication/annotation services + repositories against disposable
 * SQLite, plus shared renderer SSR. No remote access or precious D1 state.
 * Run: node scripts/test_ranking.cjs (Node 22+ with node:sqlite).
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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audiolab-c01-test-'));
const filename = path.join(directory, 'ranking.sqlite');
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
const { RankingControl } = load('components/workbench/AdvancedControls.tsx');
const ranking = { id: 'rank', type: 'ranking', label: 'Preference', required: true,
  rankingMode: 'labels', rankingInput: 'arrows',
  rankLabels: [{ id: 'c', label: 'Clear' }, { id: 'a', label: 'Natural' }, { id: 'b', label: 'Warm' }] };
const draft = { name: 'Ranking regression', description: '', instructions: 'Rank the labels', domain: 'sound',
  policy: { requiredIndependentVotes: 1, blindToOthers: true, requiresReview: false }, blocks: [ranking] };
const project = crypto.randomUUID(), dataset = crypto.randomUUID(), asset = crypto.randomUUID(), extra = crypto.randomUUID();
function render(block, value, disabled = false) {
  return renderToStaticMarkup(React.createElement('fieldset', { disabled },
    React.createElement(RankingControl, { block, value, assets: [], onChange() { throw Error('Render must not mutate answers'); } })));
}
function assertOrder(markup, labels) {
  const list = markup.slice(markup.indexOf('<ol'));
  for (let i = 1; i < labels.length; i++) assert(list.indexOf(labels[i - 1]) < list.indexOf(labels[i]), labels.join(','));
}
(async () => {
  assert(taskDraftSchema.safeParse(draft).success);
  assert.equal(model.canSubmit('ranking'), true);
  assert.equal(model.publishLimit(ranking), undefined);
  for (const patch of [
    { rankLabels: [{ id: 'a', label: 'One' }, { id: 'a', label: 'Two' }] },
    { rankLabels: [null, {}] }, { rankLabels: [{ id: ' ', label: 'A' }, { id: 'b', label: '' }] },
    { rankingMode: 'unknown' }, { rankingInput: 'unknown' }, { allowTies: true }, { randomizeOrder: true },
    { rankingMode: 'audios', stimulusSlots: ['A', 'A'] },
  ]) assert.equal(taskDraftSchema.safeParse({ ...draft, blocks: [{ ...ranking, ...patch }] }).success, false, JSON.stringify(patch));
  assert.deepEqual(validateAnswers(draft, {}, false), []);
  assert.deepEqual(validateAnswers(draft, { rank: [] }, false), []);
  assert.deepEqual(validateAnswers(draft, { rank: ['b', 'c'] }, false), []);
  assert.deepEqual(validateAnswers({ ...draft, blocks: [{ ...ranking, required: false }] }, {}, true), []);
  for (const bad of [['a', 'a', 'c'], ['a', 'b', 'unknown'], ['a', 'b', 'c', 'extra'], [1, 'a', 'b'], 'a,b,c', null, {}])
    for (const submitting of [false, true]) assert(validateAnswers(draft, { rank: bad }, submitting).length, JSON.stringify(bad));
  for (const answers of [{}, { rank: [] }, { rank: ['a', 'b'] }]) assert(validateAnswers(draft, answers, true).length);
  assert.deepEqual(validateAnswers(draft, { rank: ['b', 'c', 'a'] }, true), []);
  for (const mode of ['arrows', 'drag', 'comma']) assertOrder(render({ ...ranking, rankingInput: mode }, ['b', 'c', 'a']), ['Warm', 'Clear', 'Natural']);
  assertOrder(render(ranking, ['b']), ['Warm', 'Clear', 'Natural']);
  assert(render(ranking, undefined).includes('Use this order'));
  const legacyAudio = { ...ranking, rankingMode: undefined, stimulusSlots: ['First', 'Second'] };
  const legacyMarkup = renderToStaticMarkup(React.createElement(RankingControl, {
    block: legacyAudio, value: ['slot-1', 'slot-0'],
    assets: [{ id: 'audio-a', url: '/audio-a.wav', label: 'First' },
             { id: 'audio-b', url: '/audio-b.wav', label: 'Second' }],
    onChange() { throw Error('Render must not mutate answers'); },
  }));
  assert(legacyMarkup.includes('/audio-a.wav') && legacyMarkup.includes('/audio-b.wav'));
  assertOrder(legacyMarkup, ['Second', 'First']);
  console.log('PASS definition schemas, capability gate, draft/final validation, renderer order for all three input modes');

  sqlite.prepare('INSERT INTO projects(id,name,slug) VALUES(?,?,?)').run(project, 'C01', project);
  sqlite.prepare('INSERT INTO datasets(id,project_id,name,version) VALUES(?,?,?,?)').run(dataset, project, 'Synthetic', '1');
  for (const id of [asset, extra]) sqlite.prepare("INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key) VALUES(?,?,?,'r2',?)")
    .run(id, dataset, `${id}.wav`, `${id}.wav`);
  await assignments.addMember(db, { projectId: project, userId: 'ranking-worker', displayName: 'Ranking Worker', role: 'labeller' });
  const created = await definitions.create(db, project, taskDraftSchema.parse(draft));
  await definitions.publish(db, created.id, 1, 0);
  // Simulate a historical malformed draft bypassing today's save schema. Publish
  // must revalidate it instead of trusting that the Builder once checked it.
  const legacy = await definitions.create(db, project, { ...draft, blocks: [{ ...ranking, rankLabels: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }] });
  await assert.rejects(definitions.publish(db, legacy.id, 1, 0), TaskDefinitionPublicationError);
  const unsupported = await definitions.create(db, project, { ...draft, blocks: [{ id: 'r', type: 'continuous_rating', label: 'Preview', required: true }] });
  await assert.rejects(definitions.publish(db, unsupported.id, 1, 0), TaskDefinitionPublicationError);
  assert.equal((await definitions.get(db, legacy.id)).publishedVersion, 0);
  const task = await instances.create(db, { projectId: project, definitionId: created.id, definitionVersion: 1, assetId: asset });
  const assigned = await assignments.create(db, { projectId: project, taskInstanceId: task.id, labellerId: 'ranking-worker' });
  const input = (answers, expectedRevision) => ({ labellerId: 'ranking-worker', answers, expectedRevision });
  await annotations.save(db, assigned.id, input({}, 0), 'draft');
  await annotations.save(db, assigned.id, input({ rank: ['b'] }, 1), 'draft');
  const ordered = ['b', 'c', 'a'];
  await annotations.save(db, assigned.id, input({ rank: ordered }, 2), 'draft');
  // Close/reopen the actual SQLite file: success cannot rely on service state.
  sqlite.close(); sqlite = new DatabaseSync(filename); sqlite.exec('PRAGMA foreign_keys=ON');
  assert.deepEqual((await annotations.current(db, assigned.id, 'ranking-worker')).current.answers.rank, ordered);
  await assert.rejects(annotations.save(db, assigned.id, { ...input({ rank: ordered }, 3), labellerId: 'other' }, 'draft'), AnnotationLabellerMismatchError);
  await assert.rejects(annotations.save(db, assigned.id, input({ rank: ordered }, 1), 'draft'), AnnotationConflictError);
  for (const bad of [['b', 'b', 'a'], ['b', 'c'], ['x', 'c', 'a'], 'b,c,a', null])
    await assert.rejects(annotations.save(db, assigned.id, input({ rank: bad }, 3), 'submitted'), AnnotationAnswerError);
  assert.equal((await annotations.history(db, assigned.id, 'ranking-worker')).length, 3);
  // Editing the draft must not change the already assigned v1 vocabulary.
  await definitions.update(db, created.id, 1, { ...draft, blocks: [{ ...ranking, rankLabels: [{ id: 'new-a', label: 'A' }, { id: 'new-b', label: 'B' }] }] });
  await annotations.save(db, assigned.id, input({ rank: ordered }, 3), 'submitted');
  sqlite.close(); sqlite = new DatabaseSync(filename); sqlite.exec('PRAGMA foreign_keys=ON');
  const current = (await annotations.current(db, assigned.id, 'ranking-worker')).current;
  assert.equal(current.status, 'submitted'); assert.deepEqual(current.answers.rank, ordered);
  assert.deepEqual((await annotations.history(db, assigned.id, 'ranking-worker')).map(r => r.answers), [{}, { rank: ['b'] }, { rank: ordered }, { rank: ordered }]);
  assert.deepEqual(JSON.parse(sqlite.prepare('SELECT answers_json FROM annotation_revisions WHERE id=?').get(current.id).answers_json).rank, ordered);
  assertOrder(render(ranking, current.answers.rank, true), ['Warm', 'Clear', 'Natural']);
  await assert.rejects(annotations.save(db, assigned.id, input({ rank: ordered }, 4), 'draft'), AnnotationConflictError);
  console.log('PASS publish -> real assignment -> partial/full drafts -> reopen DB -> submit -> history/read-only render; invalid/stale/foreign writes rejected');

  const audioRanking = { ...ranking, rankingMode: 'audios', stimulusSlots: ['First', 'Second'] };
  const audioDefinition = await definitions.create(db, project, taskDraftSchema.parse({ ...draft, blocks: [audioRanking] }));
  await definitions.publish(db, audioDefinition.id, 1, 0);
  const audioTask = await instances.create(db, { projectId: project, definitionId: audioDefinition.id, definitionVersion: 1, assetId: asset, audioAssetIds: [asset, extra] });
  const audioAssignment = await assignments.create(db, { projectId: project, taskInstanceId: audioTask.id, labellerId: 'ranking-worker' });
  const audioSaved = await annotations.save(db, audioAssignment.id, input({ rank: ['slot-1', 'slot-0'] }, 0), 'submitted');
  assert.deepEqual(audioSaved.answers.rank, ['slot-1', 'slot-0']);
  assert.deepEqual((await instances.get(db, audioTask.id)).audioAssets.map(a => a.id), [asset, extra]);
  assert(validateAnswers({ ...draft, blocks: [audioRanking] }, { rank: ['slot-1', 'slot-0'] }, true, { audioAssetCount: 1 }).length);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('PASS audio-slot identity and pinned asset order; all FK constraints intact');
  console.log(`Evidence database (disposable): ${filename}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sqlite.close());
