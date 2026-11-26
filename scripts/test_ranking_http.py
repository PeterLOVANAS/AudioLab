#!/usr/bin/env python3
"""C01 live HTTP regression. Creates synthetic definitions/assignments.

Run ONLY against a disposable local D1 server, never the precious copied state:
  python3 scripts/test_ranking_http.py PROJECT_UUID DATASET_UUID \
    http://127.0.0.1:5181 --disposable-local
Uses existing asset metadata; does not modify assets or source labels.
"""
import json
import sys
import uuid
from urllib.parse import urlencode
from test_annotations import api, check
import test_annotations

if __name__ == '__main__':
    if len(sys.argv) != 5 or sys.argv[4] != '--disposable-local':
        sys.exit(__doc__)
    project, dataset, base = sys.argv[1:4]
    if not base.startswith(('http://127.0.0.1:', 'http://localhost:')):
        sys.exit('A disposable localhost server is required.')
    test_annotations.BASE = base.rstrip('/')
    assets = check(200, api('GET', '/api/v1/assets?' + urlencode({'datasetId': dataset})))['assets']
    assert len(assets) >= 2, 'Two asset metadata records are required for audio-slot ranking.'
    worker = 'c01-ranking-' + uuid.uuid4().hex[:8]
    check(201, api('POST', '/api/v1/project-members', {
        'projectId': project, 'userId': worker, 'displayName': worker, 'role': 'labeller'}))
    draft = {
        'name': 'C01 Ranking HTTP ' + worker, 'description': '', 'domain': 'sound',
        'instructions': 'Rank the attributes. Rank 1 is most preferred.',
        'policy': {'requiredIndependentVotes': 1, 'blindToOthers': True, 'requiresReview': False},
        'blocks': [{'id': 'rank', 'type': 'ranking', 'label': 'Rank attributes',
                    'required': True, 'rankingMode': 'labels', 'rankingInput': 'arrows',
                    'rankLabels': [{'id': 'clear', 'label': 'Clear'},
                                   {'id': 'natural', 'label': 'Natural'},
                                   {'id': 'warm', 'label': 'Warm'}]}]}
    def prepare(protocol, batch=False):
        definition = check(201, api('POST', '/api/v1/task-definitions', {
            'projectId': project, 'draft': protocol}))['taskDefinition']
        published = check(201, api('POST', '/api/v1/task-definitions/' + definition['id'] + '/publish', {
            'expectedRevision': 1, 'expectedPublishedVersion': 0}))['published']
        assert published['definition']['blocks'] == protocol['blocks']
        payload = {'projectId': project, 'definitionId': definition['id'],
                   'definitionVersion': 1, 'assetId': assets[0]['id']}
        if batch:
            payload['audioAssetIds'] = [a['id'] for a in assets[:2]]
        task = check(201, api('POST', '/api/v1/task-instances', payload))['taskInstance']
        assigned = check(201, api('POST', '/api/v1/assignments', {
            'projectId': project, 'taskInstanceId': task['id'], 'labellerId': worker}))['assignment']
        return definition, assigned
    malformed = {**draft, 'blocks': [{**draft['blocks'][0], 'rankLabels': [
        {'id': 'same', 'label': 'One'}, {'id': 'same', 'label': 'Two'}]}]}
    check(400, api('POST', '/api/v1/task-definitions', {'projectId': project, 'draft': malformed}))
    unsupported = check(201, api('POST', '/api/v1/task-definitions', {
        'projectId': project, 'draft': {**draft, 'blocks': [{
            'id': 'preview', 'type': 'continuous_rating', 'label': 'Preview', 'required': True}]}}))['taskDefinition']
    check(422, api('POST', '/api/v1/task-definitions/' + unsupported['id'] + '/publish', {
        'expectedRevision': 1, 'expectedPublishedVersion': 0}))
    assert check(200, api('GET', '/api/v1/task-definitions/' + unsupported['id']))['taskDefinition']['publishedVersion'] == 0
    print('PASS HTTP malformed Ranking definition 400 and unsupported publication 422 without version changes')
    definition, assigned = prepare(draft)
    annotation = '/api/v1/assignments/' + assigned['id'] + '/annotation'
    query = '?' + urlencode({'labellerId': worker})
    def write(action, answers, revision, expected=201):
        return check(expected, api('POST', annotation + '/' + action, {
            'labellerId': worker, 'expectedRevision': revision, 'answers': answers}))
    write('draft', {}, 0)
    write('draft', {'rank': ['warm']}, 1)
    order = ['warm', 'clear', 'natural']
    write('draft', {'rank': order}, 2)
    assert check(200, api('GET', annotation + query))['current']['answers']['rank'] == order
    print('PASS HTTP publication, assigned empty/partial/full draft, fresh GET preserves exact order')
    for invalid in [None, 'warm,clear,natural', ['warm', 'warm', 'clear'],
                    ['warm', 'unknown', 'clear'], ['warm', 'clear'], [1, 'clear', 'warm'], []]:
        result = write('submit', {'rank': invalid}, 3, 422)
        assert result['issues'][0]['blockId'] == 'rank'
    write('submit', {}, 3, 422)
    for invalid in [['warm', 'warm'], ['unknown'], None, 'warm']:
        write('draft', {'rank': invalid}, 3, 422)
    check(403, api('GET', annotation + '?' + urlencode({'labellerId': 'other-worker'})))
    write('draft', {'rank': order}, 1, 409)
    result = write('submit', {'rank': order}, 3)['annotation']
    assert result['revision'] == 4 and result['status'] == 'submitted'
    current = check(200, api('GET', annotation + query))['current']
    assert current['answers']['rank'] == order
    history = check(200, api('GET', annotation + '/revisions' + query))['revisions']
    assert [r['answers'] for r in history] == [{}, {'rank': ['warm']}, {'rank': order}, {'rank': order}]
    write('draft', {'rank': order}, 4, 409)
    print('PASS HTTP 422 duplicate/unknown/missing/wrong-type; 403 foreign identity; 409 stale/locked; submit/history retrieval')
    # Leave a separate real assignment available for browser reordering/reload.
    ui_definition, ui_assignment = prepare({**draft, 'name': draft['name'] + ' UI'})
    audio_draft = {**draft, 'name': draft['name'] + ' audio', 'blocks': [{
        'id': 'rank', 'type': 'ranking', 'label': 'Rank recordings', 'required': True,
        'rankingMode': 'audios', 'rankingInput': 'arrows', 'stimulusSlots': ['First', 'Second']}]}
    _, audio_assignment = prepare(audio_draft, True)
    audio_path = '/api/v1/assignments/' + audio_assignment['id'] + '/annotation'
    saved = check(201, api('POST', audio_path + '/submit', {
        'labellerId': worker, 'expectedRevision': 0, 'answers': {'rank': ['slot-1', 'slot-0']}}))
    assert saved['annotation']['answers']['rank'] == ['slot-1', 'slot-0']
    print('PASS HTTP audio-ranking batch publication and stable slot IDs')
    print(json.dumps({'projectId': project, 'worker': worker, 'submittedAssignmentId': assigned['id'],
                      'uiAssignmentId': ui_assignment['id'], 'uiDefinitionId': ui_definition['id'],
                      'uiUrl': base + '/labeller/workspace?' + urlencode({
                          'projectId': project, 'labellerId': worker, 'view': 'assigned'})}, indent=2))
