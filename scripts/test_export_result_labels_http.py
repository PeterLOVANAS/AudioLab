#!/usr/bin/env python3
"""Publish/assign/submit/reopen comparison through marked disposable Worker/D1 only."""
import argparse
import json
import pathlib
import uuid
import requests

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--state-root', required=True)
parser.add_argument('--base-url', default='http://127.0.0.1:5175')
args = parser.parse_args()
root = pathlib.Path(args.state_root).resolve()
base = args.base_url.rstrip('/')
assert (root / 'DISPOSABLE_DEMO.json').is_file()
assert base.startswith(('http://127.0.0.1:', 'http://localhost:'))
password = (root / 'demo-login.txt').read_text().splitlines()[-1]

def login(username):
    client = requests.Session()
    client.trust_env = False
    client.headers['Origin'] = base
    response = client.post(base + '/api/v1/auth/login', json={'username': username, 'password': password}, timeout=30)
    assert response.ok, response.text[:200]
    return client

def call(client, method, route, payload=None, status=200):
    response = client.request(method, base + '/api/v1/' + route, json=payload, timeout=60)
    assert response.status_code == status, (route, response.status_code, response.text[:800])
    return response.json()


fixture = json.loads((root / 'AUDIO_COMPARISON_PUBLICATION_EVIDENCE.json').read_text())
pid, jid = fixture['projectId'], fixture['jobId']
admin, alice = login('demo-admin'), login('demo-alice')
result = call(admin, 'GET', f'team-jobs?action=results&projectId={pid}&jobId={jid}')
block = next(block for block in result['blocks'] if block['blockId'] == 'compare')
assert result['complete'] and block['type'] == 'audio_comparison'
assert block['comparisonGroups'] == 2 and block['validComparisons'] == 2 and block['unresolved'] == 0
assert block['meanSimilarity'] == 0 and block['metric'] == 'per-comparison exact agreement'
assert [row['count'] for row in block['counts']] == [2, 2]
path = f'research-export?projectId={pid}&jobId={jid}'
data = call(admin, 'GET', path)
task = data['tasks'][0]
options = {option['id']: option['label'] for option in task['task']['definition']['blocks'][0]['options']}
for revision in task['annotations']:
    readable = revision['readableAnswers']['compare']
    assert readable['label'] == 'Preferred recording in each pair'
    assert [row['answer'] for row in readable['value']] == [options[value] for value in revision['answers']['compare']]
    assert all(len(row['recordings']) == 2 and all(name.endswith('.wav') for name in row['recordings']) for row in readable['value'])
    assert revision['revisionId'] and revision['answers']['compare']
assert len(task['distributions']) == 2
for item in data['audioItems']:
    file = call(admin, 'GET', path + '&format=audio-json&audioId=' + item['audioId'])
    assert file['taskInstances'][0]['annotations'][0]['readableAnswers']['compare']['value']
call(alice, 'GET', path, status=403)
call(alice, 'GET', f'team-jobs?action=results&projectId={pid}&jobId={jid}', status=403)
for session in [admin, alice]:
    call(session, 'POST', 'auth/logout', {})
print('PASS actual Worker/D1: readable full/per-audio downloads retain raw IDs/revisions, comparison filenames and distributions, final count bars and per-group agreement, admin-only results/export. Existing finals only read; no schema changes.')
