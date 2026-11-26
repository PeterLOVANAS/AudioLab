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

admin, alice, bob = login('demo-admin'), login('demo-alice'), login('demo-bob')
project = next(p for p in call(admin, 'GET', 'projects')['projects'] if p['name'] == 'AudioLab Research')
pid = project['id']
catalog = call(admin, 'GET', 'team-jobs?action=catalog&projectId=' + pid)
dataset = next(d for d in catalog['datasets'] if d['name'] == 'MMAU test-mini')
rows = call(admin, 'GET', f'team-jobs?action=items&projectId={pid}&datasetId={dataset["id"]}')['items']
items = list({row['assetId']: row for row in reversed(rows)}.values())[:4]
assert len(items) == 4
comparison = {'id': 'compare', 'type': 'audio_comparison', 'label': 'Preferred recording in each pair', 'required': True, 'numBatch': 4, 'comparisonSize': 2, 'stimulusSlots': ['First', 'Second'], 'options': [{'id': 'left', 'label': 'First recording'}, {'id': 'right', 'label': 'Second recording'}]}
draft = {'name': 'API — publishable Audio Comparison', 'description': '', 'domain': 'sound', 'instructions': 'Compare each ordered pair independently.', 'policy': {'requiredIndependentVotes': 2, 'blindToOthers': True, 'requiresReview': False}, 'blocks': [comparison]}
definition = call(admin, 'POST', 'task-definitions', {'projectId': pid, 'draft': draft}, 201)['taskDefinition']
publish = {'expectedRevision': definition['draftRevision'], 'expectedPublishedVersion': 0}
call(alice, 'POST', f'task-definitions/{definition["id"]}/publish', publish, 403)
call(admin, 'POST', f'task-definitions/{definition["id"]}/publish', publish, 201)
body = {'jobId': str(uuid.uuid4()), 'projectId': pid, 'name': 'API — Comparison publication regression', 'datasetId': dataset['id'], 'definitionId': definition['id'], 'definitionVersion': 1, 'mode': 'voting', 'seed': 'comparison-regression', 'itemKeys': [i['key'] for i in items], 'sampleCount': 4, 'workerIds': ['demo-alice', 'demo-bob']}
plan = call(admin, 'POST', 'team-jobs?action=preview', body)['plan']
assert len(plan['batches']) == 1 and len(plan['pairs']) == 2
job = call(admin, 'POST', 'team-jobs?action=launch', {**plan['input'], 'expectedHash': plan['hash']})
assert len(job['assignments']) == 2
for name, client, answers in [('demo-alice', alice, ['right', 'left']), ('demo-bob', bob, ['left', 'right'])]:
    aid = next(a['id'] for a in job['assignments'] if a['userId'] == name)
    queue = call(client, 'GET', f'labeller/assigned-queue?projectId={pid}&labellerId={name}&queueJobId={body["jobId"]}')
    assert any(group['assignmentId'] == aid for group in queue['groups'])
    task = call(client, 'GET', 'assignments/' + aid)['taskInstance']
    ordered = [asset['id'] for asset in task['audioAssets']]
    assert len(ordered) == 4 and len(set(ordered)) == 4
    assert task['resolvedDefinition']['blocks'][0]['type'] == 'audio_comparison'
    path = f'assignments/{aid}/annotation'
    call(client, 'POST', path + '/draft', {'labellerId': name, 'expectedRevision': 0, 'answers': {}}, 201)
    call(client, 'POST', path + '/draft', {'labellerId': name, 'expectedRevision': 1, 'answers': {'compare': [answers[0], None]}}, 201)
    for invalid in [['unknown', 'left'], ['left'], ['left', None], ['left', 'right', 'left']]:
        call(client, 'POST', path + '/submit', {'labellerId': name, 'expectedRevision': 2, 'answers': {'compare': invalid}}, 422)
    call(client, 'POST', path + '/submit', {'labellerId': name, 'expectedRevision': 2, 'answers': {'compare': answers}}, 201)
    reopened = call(client, 'GET', 'assignments/' + aid)['taskInstance']
    assert [asset['id'] for asset in reopened['audioAssets']] == ordered
    revision = call(client, 'GET', path + '?labellerId=' + name)['current']
    assert revision['status'] == 'submitted' and revision['revision'] == 3 and revision['answers']['compare'] == answers
    other = bob if name == 'demo-alice' else alice
    call(other, 'GET', path + '?labellerId=' + ('demo-bob' if name == 'demo-alice' else 'demo-alice'), status=403)
assert call(admin, 'GET', f'team-jobs?action=detail&projectId={pid}&jobId={body["jobId"]}')['summary']['fullyLabelledItems'] == 4
for client in [admin, alice, bob]:
    call(client, 'POST', 'auth/logout', {})
(root / 'AUDIO_COMPARISON_PUBLICATION_EVIDENCE.json').write_text(json.dumps({'definitionId': definition['id'], 'jobId': body['jobId'], 'projectId': pid, 'workers': 2, 'recordings': 4, 'submitted': 2}, indent=2))
print('PASS actual Worker/D1: HTTP publication, 4-recording job, real worker queues, independent drafts/submissions, unknown/incomplete/excess answer denial, ordered reopen, worker isolation, and 4 fully labelled items. No schema changes.')
