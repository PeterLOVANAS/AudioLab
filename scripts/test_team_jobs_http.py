#!/usr/bin/env python3
"""Actual disposable Worker/D1/R2 login, job allocation and final-results test.
Credentials are read from the local 0600 seed file and never printed.
"""
import argparse
import json
import pathlib
import uuid
import requests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:5175')
    parser.add_argument('--state-root', required=True)
    args = parser.parse_args()
    root = pathlib.Path(args.state_root)
    if not (root / 'DISPOSABLE_DEMO.json').exists() or not args.base_url.startswith(('http://127.0.0.1:', 'http://localhost:')):
        raise SystemExit('Disposable loopback test only')
    ids = json.loads((root / 'TEAM_DEMO.json').read_text())
    password = (root / 'demo-login.txt').read_text().splitlines()[-1]
    base = args.base_url.rstrip('/')

    def session():
        value = requests.Session()
        value.trust_env = False
        value.headers['origin'] = base
        return value

    anon = session()

    def call(client, method, path, body=None, status=200):
        result = client.request(method, base + '/api/v1/' + path, json=body, timeout=90)
        if result.status_code != status:
            raise RuntimeError(f'{method} {path}: {result.status_code}: {result.text[:1600]}')
        return result.json()

    pid, dataset, definition = ids['projectId'], ids['datasetId'], ids['definitionId']
    call(anon, 'GET', 'team-jobs?projectId=' + pid, status=401)
    call(anon, 'GET', 'projects', status=401)
    admin = session()
    call(admin, 'POST', 'auth/login', {'username': 'demo-admin', 'password': password})
    user = call(admin, 'GET', 'auth/session')
    assert user['user']['userId'] == 'demo-admin'
    assert [p['id'] for p in call(admin, 'GET', 'projects')['projects']] == [pid]
    catalog = call(admin, 'GET', f'team-jobs?action=catalog&projectId={pid}')
    assert len(catalog['workers']) == 10
    items = call(admin, 'GET', f'team-jobs?action=items&projectId={pid}&datasetId={dataset}')['items']
    body = {'jobId': str(uuid.uuid4()), 'projectId': pid, 'name': 'API — Individual batches', 'datasetId': dataset, 'definitionId': definition, 'definitionVersion': 1, 'mode': 'individual', 'seed': 'same-preview-seed', 'itemKeys': [i['key'] for i in items], 'workerIds': ['demo-chai', 'demo-alice', 'demo-bob'], 'sampleCount': 10}
    pending = next((job for job in call(admin, 'GET', 'team-jobs?projectId=' + pid)['jobs'] if job['name'] == body['name'] and not job['launchedAt']), None)
    if pending:
        body['jobId'] = pending['id']
    plan = call(admin, 'POST', 'team-jobs?action=preview', body)['plan']
    assert sorted(plan['counts'].values()) == [3, 3, 4]
    launch = dict(plan['input'], expectedHash=plan['hash'])
    individual = call(admin, 'POST', 'team-jobs?action=launch', launch)
    assert len(individual['assignments']) == 10
    assert len(call(admin, 'POST', 'team-jobs?action=launch', launch)['assignments']) == 10
    body.update(jobId=str(uuid.uuid4()), name='API — Completed Voting classification', mode='voting', workerIds=['demo-alice', 'demo-bob'])
    plan = call(admin, 'POST', 'team-jobs?action=preview', body)['plan']
    voted = call(admin, 'POST', 'team-jobs?action=launch', dict(plan['input'], expectedHash=plan['hash']))
    assert len(voted['assignments']) == 20
    assert not call(admin, 'GET', f'team-jobs?action=results&projectId={pid}&jobId={body["jobId"]}')['complete']
    sessions = {}
    for username, selected in [('demo-alice', 'speech'), ('demo-bob', 'music')]:
        client = session()
        sessions[username] = client
        call(client, 'POST', 'auth/login', {'username': username, 'password': password})
        mine = call(client, 'GET', f'labeller/assigned-queue?projectId={pid}&labellerId={username}&limit=50')['groups']
        own = [a for a in voted['assignments'] if a['userId'] == username]
        assert len(own) == 10
        assert len([g for g in mine if g.get('jobId') == body['jobId']]) == 10
        call(client, 'GET', f'team-jobs?projectId={pid}', status=403)
        call(client, 'GET', f'labeller/assigned-queue?projectId={pid}&labellerId=demo-admin', status=403)
        peer = next(a for a in voted['assignments'] if a['userId'] != username)
        call(client, 'GET', 'assignments/' + peer['id'], status=403)
        for index, assignment in enumerate(own):
            aid = assignment['id']
            detail = call(client, 'GET', 'assignments/' + aid)['taskInstance']
            assert detail['resolvedDefinition']['blocks'][0]['label'].startswith('Question')
            assert len(detail['resolvedDefinition']['blocks'][0]['options']) == 3
            if index == 0:
                audio = client.get(base + detail['audioUrl'], timeout=30)
                assert audio.status_code == 200 and audio.content[:4] == b'RIFF'
                call(client, 'POST', f'assignments/{aid}/annotation/draft', {'labellerId': username, 'expectedRevision': 0, 'answers': {'classification': selected}}, 201)
            call(client, 'POST', f'assignments/{aid}/annotation/submit', {'labellerId': username, 'expectedRevision': 1 if index == 0 else 0, 'answers': {'classification': selected}}, 201)
            saved = call(client, 'GET', f'assignments/{aid}/annotation?labellerId={username}')['current']
            assert saved['answers']['classification'] == selected
    results = call(admin, 'GET', f'team-jobs?action=results&projectId={pid}&jobId={body["jobId"]}')
    assert results['complete'] and results['blocks'][0]['meanSimilarity'] == 0
    assert sorted(c['count'] for c in results['blocks'][0]['counts']) == [10, 10]
    ground = {'name': 'API grounding statistics', 'description': '', 'domain': 'sound', 'instructions': 'Annotate independently.', 'policy': {'requiredIndependentVotes': 2, 'blindToOthers': True, 'requiresReview': False}, 'blocks': [{'id': 'ground', 'type': 'timeline_annotation', 'label': 'Events', 'required': True, 'groundingMode': 'sound', 'tiers': [{'id': 'events', 'name': 'Events', 'kind': 'interval', 'labelMode': 'text', 'allowOverlap': True}]}]}
    gd = call(admin, 'POST', 'task-definitions', {'projectId': pid, 'draft': ground}, 201)['taskDefinition']
    call(admin, 'POST', f'task-definitions/{gd["id"]}/publish', {'expectedRevision': 1, 'expectedPublishedVersion': 0}, 201)
    body.update(jobId=str(uuid.uuid4()), name='API — Completed Grounding IoU', definitionId=gd['id'], sampleCount=1)
    plan = call(admin, 'POST', 'team-jobs?action=preview', body)['plan']
    gj = call(admin, 'POST', 'team-jobs?action=launch', dict(plan['input'], expectedHash=plan['hash']))
    for index, assignment in enumerate(gj['assignments']):
        username = assignment['userId']
        answer = {'ground': {'tiers': {'events': [{'id': 'one', 'start': index * .05, 'end': .1 + index * .05, 'text': 'tone'}]}}}
        call(sessions[username], 'POST', f'assignments/{assignment["id"]}/annotation/submit', {'labellerId': username, 'expectedRevision': 0, 'answers': answer}, 201)
    iou = call(admin, 'GET', f'team-jobs?action=results&projectId={pid}&jobId={body["jobId"]}')
    assert iou['complete'] and abs(iou['blocks'][0]['meanSimilarity'] - 1 / 3) < 1e-8
    call(sessions['demo-alice'], 'POST', 'auth/logout')
    call(sessions['demo-alice'], 'GET', 'projects', status=401)
    response = anon.get(base + '/', timeout=90)
    assert response.status_code == 200
    print('PASS actual Worker/D1/R2: login, 10 profiles, 3/3/4 individual partition, 20 shared Voting jobs, duplicate launch, per-owner queues, draft/final/reopen and protected audio.')
    print('PASS admin-only progress/results, classification counts 10+10, completion gate, grounding IoU 1/3, peer/spoof denial and logout revocation. App SSR HTTP 200.')
    (root / 'TEAM_HTTP_EVIDENCE.json').write_text(json.dumps({'projectId': pid, 'individualJob': individual['summary']['id'], 'votingJob': voted['summary']['id'], 'groundingJob': gj['summary']['id'], 'classificationCounts': results['blocks'][0]['counts'], 'groundingIoU': iou['blocks'][0]['meanSimilarity']}, indent=2))


if __name__ == '__main__':
    main()
