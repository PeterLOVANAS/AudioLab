/** Derive public request-shape documentation from the actual Zod validators.
 * Semantic refinements, identity/resource checks and answer validation still run
 * on the server. JSON Schema alone cannot describe those persistence invariants.
 */
const fs = require('node:fs'), path = require('node:path'), ts = require('@typescript/typescript6');
const { toJSONSchema } = require('zod');
const root = path.resolve(__dirname, '..'), cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',code)(name => name.startsWith('@/') ? load(name.slice(2)+'.ts') : name.startsWith('.') ? load(path.posix.join(path.posix.dirname(file),name)+'.ts') : require(name),mod,mod.exports);
  return mod.exports;
}
const modules = {
  'task-definitions': ['taskDraftSchema','createTaskDefinitionSchema','updateTaskDefinitionSchema','publishTaskDefinitionSchema'],
  'task-instances': ['createTaskInstanceSchema'],
  'assignments': ['createMemberSchema','createAssignmentSchema','startAssignmentSchema'],
  'annotations': ['annotationWriteSchema'],
  'team-jobs': ['jobInputSchema','workerProfileSchema','teamSchema'],
  'assignment-allocation': ['allocationSchema','confirmAllocationSchema'],
  'dataset-ingestion': ['ingestionSchema'],
  'candidate-sets': ['createCandidateSetSchema'],
};
const schemas = {};
for (const [file,names] of Object.entries(modules)) {
  const source = 'lib/backend/validation/'+file+'.ts', exports = load(source);
  for (const name of names) schemas[name] = { source, schema: toJSONSchema(exports[name], {io:'input',unrepresentable:'any'}) };
}
const value = JSON.stringify({description:'Generated request shapes; server semantic/refinement/authorization checks remain authoritative.',schemas},null,2)+'\n';
const target = path.join(root,'docs/api/request-schemas.json');
if (require.main === module && process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target,'utf8') !== value) throw Error('API request schemas stale: node scripts/generate_api_schemas.cjs');
  console.log('PASS actual Zod request-schema documentation');
} else if (require.main === module) { fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value); }
module.exports = { load };
