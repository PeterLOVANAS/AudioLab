#!/usr/bin/env python3
"""Seed/verify local presentation fixtures through the actual Worker APIs.

Only use a server started with AUDIOLAB_LOCAL_STATE pointing at the disposable
copy from prepare_assignment_demo.py. This script validates loopback and an
explicit operator flag, not the server's persistence directory or authentication.
"""
import argparse
import io
import json
import math
import struct
import urllib.parse
import wave
import requests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--disposable-state-confirmed', action='store_true', required=True)
    parser.add_argument('--slug', default='assignment-mvp-demo')
    parser.add_argument('--verify', action='store_true', help='Allocate and submit two independent test responses')
    args = parser.parse_args()
    parsed = urllib.parse.urlparse(args.base_url)
    if parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1') or parsed.path not in ('', '/'):
        raise SystemExit('Only a loopback HTTP server is permitted')
    session = requests.Session()
    session.trust_env = False
    root = args.base_url.rstrip('/') + '/api/v1/'

    def call(method, path, body=None, **kwargs):
        result = session.request(method, root + path, json=body, timeout=90, allow_redirects=False, **kwargs)
        if result.status_code not in (200, 201):
            raise RuntimeError(f'{method} {path}: {result.status_code} {result.text[:1200]}')
        return result.json()

    projects = call('GET', 'projects')['projects']
    project = next((p for p in projects if p['slug'] == args.slug), None)
    if not project:
        project = call('POST', 'projects', {'name': 'Assignment MVP Demo' if not args.verify else 'Assignment MVP API Check', 'slug': args.slug})['project']
    pid = project['id']
    members = call('GET', 'project-members?projectId=' + pid)['members']
    for user, name, role in [('dev-admin', 'Local Demo Admin', 'admin'), ('dev-alice', 'Alice', 'labeller'), ('dev-bob', 'Bob', 'labeller')]:
        if not any(member['userId'] == user for member in members):
            call('POST', 'project-members', {'projectId': pid, 'userId': user, 'displayName': name, 'role': role})
    datasets = call('GET', 'datasets?projectId=' + pid)['datasets']
    dataset = next((d for d in datasets if d['name'] == '10 question items'), None)
    if not dataset:
        dataset = call('POST', 'datasets', {'projectId': pid, 'name': '10 question items', 'version': 'v1', 'description': 'Ten separate questions over two locally generated WAVs.'})['dataset']
    did = dataset['id']
    assets = call('GET', 'assets?datasetId=' + did)['assets']
    audio_ids = []
    for index, frequency in enumerate((330, 660)):
        name = f'demo-tone-{index}.wav'
        asset = next((a for a in assets if a['originalPath'] == name), None)
        if not asset:
            output = io.BytesIO()
            with wave.open(output, 'wb') as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b''.join(struct.pack('<h', int(5000 * math.sin(2 * math.pi * frequency * i / 16000))) for i in range(16000)))
            asset = call('POST', 'assets', data={'datasetId': did, 'originalPath': name}, files={'audio': (name, output.getvalue(), 'audio/wav')})['asset']
        audio_ids.append(asset['id'])
    field = lambda text: {'type': 'text', 'visibility': 'worker', 'value': text}
    records = []
    for index, aid in enumerate(audio_ids):
        items = []
        for item in range(5):
            number = index * 5 + item + 1
            items.append({'item_id': f'q-{number:02}', 'fields': {'question': field(f'Question {number}: how would you describe this tone?'), 'options': {'type': 'choices', 'visibility': 'worker', 'value': [{'id': 'steady', 'label': 'Steady tone'}, {'id': 'varying', 'label': 'Varying tone'}, {'id': 'uncertain', 'label': 'Uncertain'}]}}})
        records.append({'sample_id': f'tone-{index}', 'audio_id': aid, 'fields': {'instructions': field(f'Listen to recording {index + 1}. Answer each assigned question independently.')}, 'items': items})
    ingest = {'schema_version': 1, 'dataset_id': did, 'source_version': 'v1', 'provenance': {'origin': 'local-demo', 'revision': '1'}, 'records': records}
    params = urllib.parse.urlencode({'projectId': pid, 'userId': 'dev-admin'})
    assert call('POST', 'dataset-ingestion/import?' + params, ingest)['ok']
    draft = {'name': 'Demo dynamic audio questions', 'description': 'One item per task. Independent responses; no shared answers.', 'domain': 'sound', 'instructions': 'Listen independently.', 'instructionBinding': {'kind': 'dataset', 'fieldId': 'sample.instructions', 'type': 'string'}, 'policy': {'requiredIndependentVotes': 2, 'blindToOthers': True, 'requiresReview': False}, 'blocks': [{'id': 'classification', 'type': 'single_choice', 'label': 'Question', 'required': True, 'answerAppearance': 'exam', 'sourceBindings': {'label': {'kind': 'dataset', 'fieldId': 'item.question', 'type': 'string'}, 'options': {'kind': 'dataset', 'fieldId': 'item.options', 'type': 'choices'}}}]}
    definitions = call('GET', 'task-definitions?projectId=' + pid)['definitions']
    definition = next((d for d in definitions if d['name'] == draft['name']), None)
    if not definition:
        definition = call('POST', 'task-definitions', {'projectId': pid, 'draft': draft})['taskDefinition']
    if not definition['publishedVersion']:
        call('POST', 'task-definitions/' + definition['id'] + '/publish', {'expectedRevision': definition['draftRevision'], 'expectedPublishedVersion': 0})
    items = call('GET', 'assignment-allocation?' + urllib.parse.urlencode({'projectId': pid, 'adminId': 'dev-admin', 'datasetId': did}))['items']
    assert len(items) == 10
    request = {'projectId': pid, 'adminId': 'dev-admin', 'datasetId': did, 'definitionId': definition['id'], 'definitionVersion': 1, 'itemKeys': [item['key'] for item in items], 'labellerIds': ['dev-alice', 'dev-bob'], 'independentLabellers': 2, 'mode': 'fixed'}
    preview = call('POST', 'assignment-allocation?action=preview', request)['preview']
    assert preview['assignments'] == 20
    if args.verify:
        body = dict(request, pairs=[{'itemKey': pair['itemKey'], 'labellerId': pair['labellerId']} for pair in preview['pairs']])
        confirmed = call('POST', 'assignment-allocation?action=confirm', body)['result']
        assert call('POST', 'assignment-allocation?action=confirm', body)['result']['created'] == 0
        first_record = None
        for worker, choice in [('dev-alice', 'steady'), ('dev-bob', 'varying')]:
            qpath = 'labeller/assigned-queue?' + urllib.parse.urlencode({'projectId': pid, 'labellerId': worker})
            queue = call('GET', qpath)
            assert queue['totalCompleteGroups'] == 10 and len(queue['groups']) == 10
            group = next((g for g in queue['groups'] if first_record is None or g['sourceRecordId'] == first_record), None)
            assert group
            first_record = group['sourceRecordId']
            aid = group['assignmentId']
            detail = call('GET', 'assignments/' + aid)
            task = detail['taskInstance']
            assert task['resolvedDefinition']['blocks'][0]['label'].startswith('Question')
            assert len(task['resolvedDefinition']['blocks'][0]['options']) == 3
            assert task['resolvedDefinition']['instructions'].startswith('Listen to recording')
            audio = session.get(args.base_url.rstrip('/') + task['audioUrl'], timeout=30)
            assert audio.status_code == 200 and audio.content[:4] == b'RIFF'
            current_path = f'assignments/{aid}/annotation?' + urllib.parse.urlencode({'labellerId': worker})
            current = call('GET', current_path)['current']
            if not current:
                call('POST', f'assignments/{aid}/annotation/draft', {'labellerId': worker, 'expectedRevision': 0, 'answers': {'classification': choice}})
                call('POST', f'assignments/{aid}/annotation/submit', {'labellerId': worker, 'expectedRevision': 1, 'answers': {'classification': choice}})
            saved = call('GET', current_path)['current']
            assert saved['answers']['classification'] == choice and saved['status'] == 'submitted'
            assert call('GET', qpath)['totalSubmitted'] == 1
        print('PASS actual Worker/D1/R2: 10 items × 2 workers = 20; retry 0; independent draft/submit/reopen; correct dynamic fields, audio and counts.')
        print(json.dumps(confirmed))
    print(json.dumps({'project': project['name'], 'projectId': pid, 'datasetId': did, 'definitionId': definition['id'], 'items': 10, 'previewAssignments': 20, 'newAssignments': preview['newAssignments']}, indent=2))


if __name__ == '__main__':
    main()
