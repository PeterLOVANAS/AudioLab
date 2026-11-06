#!/usr/bin/env python3
"""Real AudioLab 2.0 HTTP integration test for Builder/grounding extensions.

Run on a *local* Vinext + D1/R2 server after migrations 0001–0007:
  python3 -u scripts/test_builder_extensions_http.py PROJECT_UUID DATASET_UUID [BASE_URL]

This uses a REAL existing MMAU audio asset without uploading another WAV.
It creates a scratch definition, publishes it, creates a task instance and
labeller assignment, and submits a structured phonetic timeline answer.
It intentionally writes new test rows to the local D1 DB; use a COPY of the
Cloudflare local state in the dedicated review worktree, never production.

This test verifies the contract that lets Friend B's Task Builder coexist
with Friend D's future Labeller Workspace. It does not test browser rendering.
"""
import json
import sys
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def request(method, path, payload=None):
    raw = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = Request(BASE + path, data=raw, method=method,
                  headers={'Content-Type': 'application/json'} if raw else {})
    try:
        response = urlopen(req, timeout=30)
    except HTTPError as error:
        response = error
    except URLError as error:
        raise RuntimeError('Cannot contact local Vinext server: ' + str(error))
    with response:
        data = response.read()
        try:
            body = json.loads(data.decode()) if data else {}
        except ValueError:
            body = {'nonJSON': data[:200].decode('utf-8', 'replace')}
        return response.code, body


def expect(code, path, method='GET', payload=None):
    status, body = request(method, path, payload)
    assert status == code, 'HTTP {} expected {}: {}'.format(status, code, body)
    return body


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit('Usage: python3 scripts/test_builder_extensions_http.py PROJECT_UUID DATASET_UUID [BASE_URL]')
    PROJECT, DATASET = sys.argv[1:3]
    BASE = (sys.argv[3] if len(sys.argv) > 3 else 'http://localhost:5173').rstrip('/')
    suffix = uuid.uuid4().hex[:8]

    assets = expect(200, '/api/v1/assets?' + urlencode({'datasetId': DATASET}))['assets']
    assert assets, 'Import an MMAU WAV into the review database first.'
    asset_id = assets[0]['id']
    audio = expect(200, '/api/v1/task-definitions?' + urlencode({'projectId': PROJECT}))
    assert 'definitions' in audio
    print('[1] Existing dataset and task-definition APIs available', flush=True)

    # Display-only section and callout are persisted INSIDE the definition,
    # but must never occupy keys of human-submitted `answers`.
    draft = {
        'name': 'Builder extension QA ' + suffix,
        'description': 'Tests conditional display, confirmation and timelines',
        'domain': 'speech',
        'instructions': 'Listen to the complete clip and annotate one interval.',
        'policy': {'requiredIndependentVotes': 1, 'blindToOthers': True, 'requiresReview': False},
        'workspace': {'waveform': True, 'allowTextGridImport': True},
        'blocks': [
            {'id': 'instructions', 'type': 'section', 'label': 'Listening protocol',
             'required': False, 'tone': 'info', 'description': 'Check the whole recording.'},
            {'id': 'primary', 'type': 'audio_player', 'label': 'Audio playback', 'required': False,
             'showWaveform': True},
            {'id': 'presence', 'type': 'single_choice', 'label': 'Target sound audible?', 'required': True,
             'answerAppearance': 'cards',
             'options': [{'id': 'present', 'label': 'Present'}, {'id': 'absent', 'label': 'Absent'}]},
            {'id': 'green_panel', 'type': 'callout', 'label': 'Absence confirmation',
             'required': False, 'tone': 'success',
             'description': 'Confirm after listening to the entire audio.',
             'showWhen': {'blockId': 'presence', 'equals': 'absent'}},
            {'id': 'confirmation', 'type': 'boolean', 'required': True,
             'label': 'I listened all the way through', 'requiredValue': True,
             'showWhen': {'blockId': 'presence', 'equals': 'absent'}},
            {'id': 'grounding', 'type': 'timeline_annotation', 'label': 'Word / phone intervals',
             'required': True, 'alphabet': 'IPA', 'transcriptionLevel': 'broad',
             'tiers': [
                 {'id': 'words', 'name': 'Words', 'labelMode': 'text',
                  'kind': 'interval', 'allowOverlap': True},
                 {'id': 'phones', 'name': 'Phones', 'labelMode': 'ipa',
                  'kind': 'interval', 'allowOverlap': True, 'parentTierId': 'words'},
             ]},
            {'id': 'live_summary', 'type': 'transcript_summary', 'label': 'Current words and phones',
             'required': False, 'sourceTimelineBlockId': 'grounding', 'summaryMode': 'both'},
        ],
    }
    created = expect(201, '/api/v1/task-definitions', 'POST', {'projectId': PROJECT, 'draft': draft})['taskDefinition']
    definition_id = created['id']
    expect(201, '/api/v1/task-definitions/{}/publish'.format(definition_id), 'POST', {
        'expectedRevision': created['draftRevision'],
        'expectedPublishedVersion': created['publishedVersion'],
    })
    print('[2] Display, conditional, player and timeline blocks published', flush=True)

    published = expect(200, '/api/v1/task-definitions/{}/versions/1'.format(definition_id))['published']['definition']
    assert [block['type'] for block in published['blocks']] == [block['type'] for block in draft['blocks']]
    print('[3] Frozen snapshot includes all block types and properties', flush=True)

    task = expect(201, '/api/v1/task-instances', 'POST', {
        'projectId': PROJECT, 'definitionId': definition_id, 'definitionVersion': 1, 'assetId': asset_id,
    })['taskInstance']
    person = 'builder-check-' + suffix
    expect(201, '/api/v1/project-members', 'POST', {
        'projectId': PROJECT, 'userId': person, 'displayName': 'Builder Checker', 'role': 'labeller',
    })
    assignment = expect(201, '/api/v1/assignments', 'POST', {
        'projectId': PROJECT, 'taskInstanceId': task['id'], 'labellerId': person,
    })['assignment']['id']
    base = '/api/v1/assignments/{}/annotation'.format(assignment)
    print('[4] Real asset bound to Task Instance and assigned to development Labeller', flush=True)

    # Labeller can save an empty draft. This matters while creating intervals:
    # intermediate edits aren't expected to be ready for final submission.
    expect(201, base + '/draft', 'POST', {'labellerId': person, 'expectedRevision': 0, 'answers': {}})
    print('[5] Empty draft revision accepted', flush=True)

    answer = {'tiers': {
        'words': [{'id': 'w1', 'start': .15, 'end': .8, 'text': 'hello', 'speaker': 'Speaker 1'}],
        'phones': [{'id': 'p1', 'start': .2, 'end': .3, 'text': 'h',
                    'speaker': 'Speaker 1', 'parentId': 'w1'}],
    }}
    wrong = {'presence': 'absent', 'confirmation': False, 'grounding': answer}
    invalid = expect(422, base + '/submit', 'POST', {
        'labellerId': person, 'expectedRevision': 1, 'answers': wrong,
    })
    assert invalid.get('issues'), invalid
    print('[6] Required True confirmation rejects False (422)', flush=True)

    wrong = {'presence': 'absent', 'confirmation': True, 'grounding': answer, 'green_panel': 'wrong'}
    expect(422, base + '/submit', 'POST', {
        'labellerId': person, 'expectedRevision': 1, 'answers': wrong,
    })
    print('[7] Display-only panels cannot appear in annotation answers (422)', flush=True)

    wrong = {'presence': 'absent', 'confirmation': True, 'grounding': {
        'tiers': {'words': [], 'phones': [{'id': 'p1', 'start': .3, 'end': .2, 'text': 'bad'}]}}}
    expect(422, base + '/submit', 'POST', {
        'labellerId': person, 'expectedRevision': 1, 'answers': wrong,
    })
    print('[8] Reversed time interval rejected (422)', flush=True)

    valid = {'presence': 'absent', 'confirmation': True, 'grounding': answer}
    saved = expect(201, base + '/submit', 'POST', {
        'labellerId': person, 'expectedRevision': 1, 'answers': valid,
    })['annotation']
    assert saved['revision'] == 2 and saved['status'] == 'submitted'
    print('[9] Valid phonetic grounding answer submitted, revision 2', flush=True)
    recent = expect(200, base + '?' + urlencode({'labellerId': person}))['current']
    assert recent['answers']['grounding']['tiers']['phones'][0]['text'] == 'h'
    assert 'green_panel' not in recent['answers'] and 'instructions' not in recent['answers']
    print('[10] DB roundtrip preserved timings/phones without display answers', flush=True)
    print('PASS: Builder extensions through real D1/Task Instance/Annotation APIs.', flush=True)
