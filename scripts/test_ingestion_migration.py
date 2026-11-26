#!/usr/bin/env python3
"""Test 0014 only on a disposable raw copy of a local SQLite/D1 database.
Usage: python3 scripts/test_ingestion_migration.py PATH_TO_LOCAL_SQLITE
Copies main/WAL/SHM, checks source stability, and opens only that copy in SQLite.
Never connects to remote D1 or opens preserved state through SQLite.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import uuid

if len(sys.argv) != 2:
    sys.exit(__doc__)
source = Path(sys.argv[1]).resolve(strict=True)
folder = Path(tempfile.mkdtemp(prefix='audiolab-0014-regression-'))
files = [p for p in [source, Path(str(source)+'-wal'), Path(str(source)+'-shm')] if p.exists()]
def hashes():
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
before_hashes = hashes()
for p in files:
    shutil.copy2(p, folder/p.name)
assert before_hashes == hashes(), 'Source changed during copy; do not test inconsistent copy'
c = sqlite3.connect(folder/source.name)
c.execute('PRAGMA foreign_keys=ON')
assert c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
columns = {t: [r[1] for r in c.execute('PRAGMA table_info("'+t+'")')] for t in tables}
def snapshot():
    return {t: c.execute('SELECT '+','.join('"'+v+'"' for v in columns[t])+' FROM "'+t+'" ORDER BY rowid').fetchall() for t in tables}
original = snapshot()
c.executescript((Path(__file__).resolve().parents[1]/'migrations/0014_canonical_ingestion.sql').read_text())
assert snapshot() == original
c.execute('SAVEPOINT regression')
row = c.execute('SELECT id,asset_id,source_record_id,source_domain,question FROM source_records WHERE ingestion_hash IS NULL LIMIT 1').fetchone()
assert row, 'Fixture needs an existing legacy source row'
upsert = '''INSERT INTO source_records(id,asset_id,source_record_id,source_domain,question) VALUES(?,?,?,?,?)
 ON CONFLICT(asset_id,source_record_id) DO UPDATE SET question=excluded.question'''
c.execute(upsert, row)
c.execute(upsert, (*row[:4], 'Legacy updated question'))
assert c.execute('SELECT question FROM source_records WHERE id=?',(row[0],)).fetchone()[0] == 'Legacy updated question'
print('PASS identical and changed legacy upserts')
insert = '''INSERT INTO source_records(id,asset_id,source_record_id,source_domain,canonical_json,ingestion_hash,canonical_dataset_id)
 VALUES(?,?,?,'unknown',?,?,?) ON CONFLICT(asset_id,source_record_id) DO NOTHING'''
dataset = c.execute('SELECT dataset_id FROM audio_assets WHERE id=?',(row[1],)).fetchone()[0]
body = json.dumps({'sample_id':str(uuid.uuid4()),'item_id':'q','source_version':'v1','sample_fields':{},'metadata':{}})
record, identifier = str(uuid.uuid4()), str(uuid.uuid4())
args = (identifier,row[1],record,body,'hash-one',dataset)
def denied(sql, args):
    try:
        c.execute(sql,args)
    except sqlite3.DatabaseError as e:
        assert 'CANONICAL_' in str(e), str(e)
    else:
        raise AssertionError('Expected canonical conflict')
denied(insert,(row[0],row[1],row[2],body,'canonical-adoption',dataset))
c.execute(insert,args)
c.execute(insert,args)
assert c.execute('SELECT count(*) FROM source_records WHERE id=?',(identifier,)).fetchone()[0] == 1
denied(insert,(*args[:4],'different-hash',dataset))
denied(upsert,(identifier,row[1],record,'unknown','Legacy overwrite'))
denied('UPDATE source_records SET question=? WHERE id=?',('Overwrite',identifier))
print('PASS canonical identical retry, conflicts, legacy adoption/overwrite denial and immutability')
c.execute('ROLLBACK TO regression');c.execute('RELEASE regression')
assert snapshot() == original
assert c.execute('PRAGMA foreign_key_check').fetchall() == []
c.close()
assert before_hashes == hashes()
print('PASS existing data/FKs and preserved main/WAL/SHM hashes unchanged')
print('Disposable evidence:',folder)
