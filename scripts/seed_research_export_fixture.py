#!/usr/bin/env python3
"""Seed ONE marked historical comparison version in disposable test data only.
Server must be stopped. This does not relax Audio Comparison's publication gate.
"""
import argparse,pathlib,tempfile,sqlite3,uuid,os
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state-root',required=True);p.add_argument('--definition-id',required=True,type=uuid.UUID);a=p.parse_args();root=pathlib.Path(a.state_root).resolve()
if pathlib.Path(tempfile.gettempdir()).resolve() not in root.parents or not (root/'DISPOSABLE_DEMO.json').is_file():raise SystemExit('Marked temporary demo only')
for candidate in (root/'v3/d1').rglob('*.sqlite'):
 db=sqlite3.connect(candidate.resolve().as_uri()+'?mode=ro',uri=True)
 if db.execute("SELECT 1 FROM sqlite_master WHERE name='task_definitions'").fetchone():db.close();filename=candidate;break
 db.close()
con=sqlite3.connect(filename);con.execute('PRAGMA foreign_keys=ON')
row=con.execute("SELECT draft_json,published_version FROM task_definitions WHERE id=? AND json_extract(draft_json,'$.name') LIKE 'API Research Export fixture %'",(str(a.definition_id),)).fetchone()
if not row or row[1]!=0:raise SystemExit('Refusing non-fixture or already-published definition')
if con.execute('SELECT 1 FROM task_instances WHERE definition_id=?',(str(a.definition_id),)).fetchone():raise SystemExit('Fixture is already used')
backup_path=root/'before-research-export-fixture.sqlite'
backup=sqlite3.connect(backup_path);con.backup(backup);backup.close();os.chmod(backup_path,0o600)
# The draft was validated by the real API. Reconstruct an old published version
# that predates the current capability gate, solely to test read compatibility.
con.execute('INSERT INTO task_definition_versions(definition_id,version,definition_json) VALUES(?,1,?)',(str(a.definition_id),row[0]));con.execute('UPDATE task_definitions SET published_version=1 WHERE id=?',(str(a.definition_id),));con.commit();con.close()
print('Seeded one historical export test version in disposable SQLite; publication code unchanged.')
