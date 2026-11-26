/** Verify coordinated migration orders without touching any filesystem database. */
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const files=fs.readdirSync(path.join(root,'migrations')).filter(name=>name.endsWith('.sql')).sort();
const before=files.filter(name=>/^000/.test(name)).map(name=>fs.readFileSync(path.join(root,'migrations',name),'utf8'));
const after=files.filter(name=>/^001[1-7]_/.test(name)).map(name=>fs.readFileSync(path.join(root,'migrations',name),'utf8'));
// The compatibility test must work in a source archive without private/cached
// Git refs. This attributed, byte-pinned historical fixture is never a runtime
// migration; the original reserved migration and author history are unchanged.
const w01=fs.readFileSync(path.join(root,'fixtures/migration-compatibility/w01-workflow.sql.fixture'),'utf8');
assert.equal(createHash('sha256').update(w01).digest('hex'),'4c7c0f1aec6a92909149602cae7a5539f8f8a76ec93223ef0e733c3ef9ffc33a');
for(const order of [[...before,w01,...after],[...before,...after,w01]]){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const sql of order)db.exec(sql);
 for(const table of ['annotation_jobs','annotation_job_assignments','worker_teams','auth_accounts','auth_access_revocations','workflow_definitions','workflow_versions'])assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),table);
 assert(db.prepare('PRAGMA table_info(annotation_jobs)').all().some(column=>column.name==='deleted_at'));
 assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();
}
console.log('PASS 0015–0017 with reserved W01/0010 applied before and after Phase 1 migrations; no duplicate workflow model.');
