/** Check the curated public documentation without reading private local state.
 * Public selection is explicit: historical plans/evidence are retained locally,
 * never silently promoted into a release because a Markdown link references them.
 * Request examples are shape checks; persisted HTTP acceptance tests remain the
 * proof of authorization, runtime answer semantics and database behavior.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('@typescript/typescript6');
const root = process.cwd();
export const publicDocs = [
  'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md',
  'ACKNOWLEDGEMENTS.md', 'THIRD_PARTY_NOTICES.md', 'RELEASE_NOTES.md',
  'docs/RELEASING.md', 'docs/api/CHOICE_RESULTS.md',
  ...['README','22_FRESH_LOCAL_SETUP','23_DATASET_INGESTION','WORKFLOW',
      'RESULTS','ARCHITECTURE','API','AUTHENTICATION','DEPLOYMENT','TESTING',
      'DEMONSTRATION','KNOWN_LIMITATIONS','LICENSE_STATUS','PROVENANCE'].map(p => `docs/${p}.md`),
  'docs/images/README.md', 'examples/datasets/synthetic/README.md',
  'fixtures/migration-compatibility/README.md',
];
const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
const internal = /^(?:docs\/(?:release|evidence)\/|explain_docs\/|DEMO_DOCS\/|IMPORTANT COMMAND\/)|^docs\/\d\d_(?!FRESH_LOCAL_SETUP|DATASET_INGESTION)/;
for (const file of publicDocs) {
  if (!existsSync(file)) { failures.push(`Missing public guide: ${file}`); continue; }
  const value = readFileSync(file, 'utf8');
  check(!/(?:\/Users\/|\/home\/[a-zA-Z])/.test(value), `${file}: personal filesystem detail`);
  for (const match of value.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = match[1].split(/\s+"/)[0].replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:)/.test(raw) || raw.startsWith('#')) continue;
    const [destination, anchor] = raw.split('#');
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURI(destination)));
    check(!target.startsWith('../') && existsSync(target), `${file}: missing link ${raw}`);
    check(!internal.test(target), `${file}: public link exposes internal evidence ${target}`);
    if (anchor && target.endsWith('.md') && existsSync(target)) {
      const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)]
        .map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-'));
      check(headings.includes(decodeURI(anchor)), `${file}: missing heading ${raw}`);
    }
  }
}

const { load } = require('./generate_api_schemas.cjs');
const schemas = JSON.parse(readFileSync('docs/api/request-schemas.json')).schemas;
const operations = JSON.parse(readFileSync('docs/api/operations.json')).operations;
const methodsByFile = new Map();
for (const op of operations) {
  check(existsSync(op.source), `${op.path}: missing handler ${op.source}`);
  if (!existsSync(op.source)) continue;
  if (!methodsByFile.has(op.source)) {
    const source = ts.createSourceFile(op.source, readFileSync(op.source, 'utf8'), ts.ScriptTarget.Latest, true);
    const names = new Set();
    for (const statement of source.statements) {
      if (statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && statement.name) names.add(statement.name.text);
      if (ts.isVariableStatement(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const item of statement.exportClause.elements) names.add(item.name.text);
      }
    }
    methodsByFile.set(op.source, names);
  }
  // Vinext synthesizes HEAD from GET; only audio HEAD is allowed by our proxy.
  const implemented = methodsByFile.get(op.source).has(op.method) ||
    (op.method === 'HEAD' && op.path === '/api/v1/assets/{id}/audio' && methodsByFile.get(op.source).has('GET'));
  check(implemented, `${op.path}: no exported ${op.method} in ${op.source}`);
  if (op.requestSchema) {
    const meta = schemas[op.requestSchema];
    check(Boolean(meta), `${op.path}: unknown request schema`);
    if (meta && op.exampleBody !== null) {
      const result = load(meta.source)[op.requestSchema].safeParse(op.exampleBody);
      check(result.success, `${op.path}: invalid ${op.requestSchema} example: ${result.success ? '' : result.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ')}`);
    }
  }
}

const notices = JSON.parse(readFileSync('third_party/manifest.json'));
for (const item of notices.packages) for (const notice of item.notices) {
  check(existsSync(notice.path), `${item.name}: missing upstream notice`);
  if (existsSync(notice.path)) check(createHash('sha256').update(readFileSync(notice.path)).digest('hex') === notice.sha256, `${item.name}: changed upstream notice bytes`);
}
for (const [command, args] of [
  [process.execPath, ['scripts/generate_api_schemas.cjs', '--check']],
  [process.env.AUDIOLAB_TEST_PYTHON || 'python3', ['-B', 'scripts/generate_api_reference.py', '--check']],
]) {
  const result = spawnSync(command, args, {stdio:'inherit'});
  check(result.status === 0, `Failed generated documentation check: ${args[0]}`);
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log(`PASS ${publicDocs.length} public guides/links/privacy, ${operations.length} API handlers/examples and upstream notice hashes`);
