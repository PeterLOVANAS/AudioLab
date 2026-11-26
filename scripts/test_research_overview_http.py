#!/usr/bin/env python3
"""Read-only Overview checks against a marked disposable local Worker/D1.

Only login/logout session state is written. Never imports, migrates, or edits
annotations. SQLite aggregates independently check the actual Worker response.
"""
import argparse
import json
import pathlib
import sqlite3
import requests

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--state-root', required=True)
parser.add_argument('--base-url', default='http://127.0.0.1:5175')
args = parser.parse_args()
root = pathlib.Path(args.state_root).resolve()
base = args.base_url.rstrip('/')
assert (root / 'DISPOSABLE_DEMO.json').is_file(), 'Disposable marker required'
assert base.startswith(('http://127.0.0.1:', 'http://localhost:'))
password = (root / 'demo-login.txt').read_text().splitlines()[-1]

def client(username=None):
    session = requests.Session()
    session.trust_env = False
    session.headers['Origin'] = base
    if username:
        response = session.post(base + '/api/v1/auth/login', json={'username': username, 'password': password}, timeout=30)
        assert response.ok, (response.status_code, response.text[:200])
    return session

admin, worker, anonymous = client('demo-admin'), client('demo-alice'), client()
projects = admin.get(base + '/api/v1/projects', timeout=30).json()['projects']
assert projects
url = base + '/api/v1/research-overview?projectId=' + projects[0]['id']
response = admin.get(url, timeout=30)
assert response.status_code == 200, (response.status_code, response.text[:500])
assert response.headers.get('cache-control') == 'no-store'
result = response.json()
assert anonymous.get(url, timeout=30).status_code == 401
assert worker.get(url, timeout=30).status_code == 403
files = [file for file in (root / 'v3/d1').rglob('*.sqlite') if file.name != 'metadata.sqlite']
assert len(files) == 1, 'Expected exactly one disposable local D1 file'
with sqlite3.connect(files[0].as_uri() + '?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    expected = db.execute("SELECT p.id FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id='demo-admin' AND m.role='admin'").fetchall()
    assert {row['id'] for row in expected} == {row['id'] for row in result['projects']}
    for project in result['projects']:
        rows = db.execute("""SELECT a.status FROM assignments a WHERE a.project_id=? AND NOT EXISTS(
          SELECT 1 FROM annotation_job_assignments ja JOIN annotation_jobs j ON j.id=ja.job_id
          WHERE ja.assignment_id=a.id AND j.deleted_at IS NOT NULL)""", (project['id'],)).fetchall()
        assert project['assignments'] == len(rows)
        assert project['submitted'] == sum(row['status'] in ('submitted', 'reviewed') for row in rows)
        assert project['datasets'] == db.execute('SELECT COUNT(*) FROM datasets WHERE project_id=?', (project['id'],)).fetchone()[0]
        assert project['audioFiles'] == db.execute('SELECT COUNT(*) FROM audio_assets a JOIN datasets d ON d.id=a.dataset_id WHERE d.project_id=?', (project['id'],)).fetchone()[0]
        assert 0 <= project['completedSourceItems'] <= project['sourceItems']
        assert 'answers' not in project and 'reference' not in project
assert result['totals']['assignments'] == sum(row['assignments'] for row in result['projects'])
assert admin.get(base + '/', timeout=30).status_code == 200
for session in [admin, worker]:
    assert session.post(base + '/api/v1/auth/logout', json={}, timeout=30).ok
print('PASS actual Worker/D1: admin Overview, independent read-only SQLite counts, dataset/audio access, no answer payloads, worker/anonymous denial and HTTP page response. ' + json.dumps(result['totals']))
