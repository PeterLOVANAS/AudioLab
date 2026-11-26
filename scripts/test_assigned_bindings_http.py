#!/usr/bin/env python3
"""C03 live assignment/source binding pipeline, writes disposable-local fixtures.

python3 scripts/test_assigned_bindings_http.py PROJECT DATASET \
  http://127.0.0.1:5181 --disposable-local
Migration 0011 must be applied to that disposable server's D1, not precious state.
"""
import json
import sys
import uuid
from urllib.parse import urlencode
import test_annotations
from test_annotations import api, check

if __name__ == '__main__':
    if len(sys.argv) != 5 or sys.argv[4] != '--disposable-local':
        sys.exit(__doc__)
    project, dataset, base = sys.argv[1:4]
    if not base.startswith(('http://127.0.0.1:', 'http://localhost:')):
        sys.exit('A disposable localhost server is required.')
    test_annotations.BASE = base.rstrip('/')
    assets = check(200, api('GET', '/api/v1/assets?' + urlencode({'datasetId': dataset})))['assets']
    suffix = uuid.uuid4().hex[:8]
    worker = 'c03-worker-' + suffix
    check(201, api('POST', '/api/v1/project-members', {'projectId': project, 'userId': worker,
                                                  'displayName': worker, 'role': 'labeller'}))
    text = {'kind': 'dataset', 'fieldId': 'question', 'type': 'string'}
    choice = {'id': 'choice', 'type': 'single_choice', 'label': 'Static fallback', 'required': True,
              'options': [{'id': 'static-a', 'label': 'A'}, {'id': 'static-b', 'label': 'B'}],
              'sourceBindings': {'label': text, 'options': {'kind': 'dataset', 'fieldId': 'choices', 'type': 'string[]'}}}
    blocks = [choice]
    for mode in ['reference', 'read_only', 'prefill']:
        blocks.append({'id': mode, 'type': 'text', 'label': mode, 'required': False,
                       'sourceBindings': {'value': {**text, 'mode': mode}}})
    draft = {'name': 'C03 live ' + suffix, 'description': '', 'instructions': 'Annotate', 'domain': 'sound',
             'blocks': blocks, 'policy': {'requiredIndependentVotes': 1, 'blindToOthers': True, 'requiresReview': False}}
    def publish(protocol):
        saved = check(201, api('POST', '/api/v1/task-definitions', {'projectId': project, 'draft': protocol}))['taskDefinition']
        check(201, api('POST', '/api/v1/task-definitions/' + saved['id'] + '/publish',
                       {'expectedRevision': 1, 'expectedPublishedVersion': 0}))
        return saved['id']
    definition = publish(draft)
    def create(asset, record=None, definition_id=definition, expected=201):
        payload = {'projectId': project, 'definitionId': definition_id, 'definitionVersion': 1, 'assetId': asset}
        if record is not None:
            payload['sourceRecordId'] = record
        return check(expected, api('POST', '/api/v1/task-instances', payload))
    def assign(task):
        return check(201, api('POST', '/api/v1/assignments', {'projectId': project,
            'taskInstanceId': task['id'], 'labellerId': worker}))['assignment']['id']
    def current(assignment):
        return check(200, api('GET', '/api/v1/assignments/' + assignment + '/annotation?' + urlencode({'labellerId': worker})))['current']
    observations = []
    jobs = []
    for asset in assets[:2]:
        listing = check(200, api('GET', '/api/v1/source-records?' + urlencode({'assetId': asset['id']})))['sourceRecords']
        original = next(row for row in listing if not row['sourceRecordId'].startswith(('c02-', 'c03-')) and len(row.get('choices') or []) == 4)
        task = create(asset['id'], original['sourceRecordId'])['taskInstance']
        assignment = assign(task)
        detail = check(200, api('GET', '/api/v1/assignments/' + assignment))['taskInstance']
        assert detail['definition']['blocks'][0]['label'] == 'Static fallback'
        runtime = detail['resolvedDefinition']['blocks']
        assert runtime[0]['label'] == original['question']
        assert [option['label'] for option in runtime[0]['options']] == original['choices']
        assert [option['id'] for option in runtime[0]['options']] == ['source-choice-1', 'source-choice-2', 'source-choice-3', 'source-choice-4']
        assert runtime[2]['type'] == 'callout' and runtime[2]['required'] is False
        assert detail['initialAnswers']['prefill'] == original['question']
        assert detail['inputContext']['snapshotId'] == task['id']
        serialized = json.dumps(detail)
        for forbidden in ['reference_answer', 'early_annotation', 'metadataJson', 'labelProvenance']:
            assert forbidden not in serialized
        path = '/api/v1/assignments/' + assignment + '/annotation'
        def write(action, answers, revision, expected=201):
            return check(expected, api('POST', path + '/' + action, {
                'labellerId': worker, 'expectedRevision': revision, 'answers': answers}))
        write('draft', {}, 0)
        for invalid in ['static-a', 'source-choice-5', 'unknown']:
            write('draft', {'choice': invalid}, 1, 422)
            write('submit', {'choice': invalid}, 1, 422)
        write('draft', {'read_only': original['question']}, 1, 422)
        check(400, api('POST', path + '/draft', {'labellerId': worker, 'expectedRevision': 1,
                   'answers': {'choice': 'unknown'}, 'options': [{'id': 'unknown', 'label': 'Injected'}]}))
        answers = {'choice': 'source-choice-2', 'prefill': 'Edited public source text'}
        write('draft', answers, 1)
        assert current(assignment)['answers'] == answers
        write('submit', answers, 2)
        assert current(assignment)['answers'] == answers
        history = check(200, api('GET', path + '/revisions?' + urlencode({'labellerId': worker})))['revisions']
        assert [row['answers'] for row in history] == [{}, answers, answers]
        observations.append(runtime[0]['label'])
        jobs.append(assignment)
    assert observations[0] != observations[1]
    print('PASS HTTP two existing MMAU assignments: resolved question/four choices, modes/prefill, draft/submit/reopen/history; invalid IDs and injected options rejected')

    # Change only a new synthetic import, never an original MMAU row.
    fixture_id = 'c03-fixture-' + suffix
    fixture = {'assetId': assets[2]['id'], 'sourceRecordId': fixture_id, 'sourceDomain': 'sound',
               'question': 'Original synthetic question', 'choices': ['One', 'Two', 'Three', 'Four'],
               'metadata': {'nested': {'answer': 'PRIVATE_METADATA'}},
               'labels': {'referenceAnswer': {'value': 'HIDDEN_GROUND_TRUTH'}, 'earlyAnnotation': 'HIDDEN_EARLY'}}
    check(200, api('POST', '/api/v1/source-records', fixture))
    pinned = create(assets[2]['id'], fixture_id)['taskInstance']
    pinned_job = assign(pinned)
    check(200, api('POST', '/api/v1/source-records', {**fixture, 'question': 'Changed import', 'choices': ['W', 'X', 'Y', 'Z']}))
    reopened = check(200, api('GET', '/api/v1/assignments/' + pinned_job))['taskInstance']
    assert reopened['resolvedDefinition']['blocks'][0]['label'] == 'Original synthetic question'
    assert reopened['resolvedDefinition']['blocks'][0]['options'][0]['label'] == 'One'
    assert reopened['sourceRecord']['question'] == 'Original synthetic question'
    assert 'HIDDEN_' not in json.dumps(reopened) and 'PRIVATE_METADATA' not in json.dumps(reopened)
    check(201, api('POST', '/api/v1/assignments/' + pinned_job + '/annotation/submit', {
        'labellerId': worker, 'expectedRevision': 0, 'answers': {'choice': 'source-choice-1'}}))
    print('PASS HTTP pinned source survives import changes, originals remain hidden, submission uses pinned options')

    missing = 'c03-missing-' + suffix
    check(200, api('POST', '/api/v1/source-records', {'assetId': assets[3]['id'], 'sourceRecordId': missing, 'sourceDomain': 'sound'}))
    create(assets[3]['id'], missing, expected=422)
    create(assets[3]['id'], expected=422)  # ambiguous, never choose first record
    check(400, api('POST', '/api/v1/task-definitions', {'projectId': project, 'draft': {**draft,
        'blocks': [{**choice, 'sourceBindings': {'label': {'kind': 'dataset', 'fieldId': 'reference_answer', 'type': 'json'}}}]}}))

    # Existing integrated audio-queue flow must create and reopen bound work.
    queue_query = {'projectId': project, 'labellerId': worker, 'definitionId': definition, 'datasetId': dataset, 'limit': 20}
    page = check(200, api('GET', '/api/v1/labeller/audio-queue?' + urlencode(queue_query)))
    eligible = None
    for group in page['groups']:
        rows = check(200, api('GET', '/api/v1/source-records?' + urlencode({'assetId': group['assets'][0]['id']})))['sourceRecords']
        if len(rows) == 1 and len(rows[0].get('choices') or []) == 4:
            eligible = group
            break
    assert eligible, 'A unique-source asset is required in the first queue page.'
    selection = {key: value for key, value in queue_query.items() if key != 'limit'}
    selection.update({'definitionVersion': 1, 'assetIds': [eligible['assets'][0]['id']]})
    opened = check(200, api('POST', '/api/v1/labeller/audio-queue', selection))['assignment']
    again = check(200, api('POST', '/api/v1/labeller/audio-queue', selection))['assignment']
    assert opened['id'] == again['id']
    page_after = check(200, api('GET', '/api/v1/labeller/audio-queue?' + urlencode(queue_query)))
    assert next(group for group in page_after['groups'] if group['key'] == eligible['key'])['assignmentId'] == opened['id']
    assert check(200, api('GET', '/api/v1/assignments/' + opened['id']))['taskInstance']['resolvedDefinition']['blocks'][0]['options']
    print('PASS HTTP integrated audio queue creates/reuses and lists the same bound assignment; missing/ambiguous/restricted sources fail explicitly')

    static = {**choice}; static.pop('sourceBindings')
    static_definition = publish({**draft, 'name': 'C03 static ' + suffix, 'blocks': [static]})
    static_task = create(assets[0]['id'], definition_id=static_definition)['taskInstance']
    static_job = assign(static_task)
    check(201, api('POST', '/api/v1/assignments/' + static_job + '/annotation/submit', {
        'labellerId': worker, 'expectedRevision': 0, 'answers': {'choice': 'static-a'}}))
    print('PASS HTTP static single-choice publication/assignment/submit unchanged')
    print(json.dumps({'definitionId': definition, 'assignmentIds': jobs, 'pinnedTaskId': pinned['id'],
                      'pinnedAssignmentId': pinned_job, 'worker': worker, 'queueAssignmentId': opened['id']}, indent=2))
