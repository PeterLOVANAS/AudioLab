#!/usr/bin/env python3
"""C05 combined HTTP/D1 smoke. Requires migration 0013 on a disposable local server.
python3 scripts/test_candidate_voting_http.py PROJECT DATASET BASE_URL --disposable-local
Creates only synthetic source records/definitions/assignments on existing assets.
"""
import sys
import uuid
from urllib.parse import urlencode
import test_annotations
from test_annotations import api, check

if __name__ == '__main__':
    if len(sys.argv) != 5 or sys.argv[4] != '--disposable-local':
        sys.exit(__doc__)
    project, dataset, base = sys.argv[1:4]
    if not base.startswith(('http://localhost:', 'http://127.0.0.1:')):
        sys.exit('A disposable localhost server is required.')
    test_annotations.BASE = base.rstrip('/')
    suffix = uuid.uuid4().hex[:8]
    admin, author, voter = ('c05-admin-' + suffix, 'c05-author-' + suffix, 'c05-voter-' + suffix)
    for user, role in [(admin, 'admin'), (author, 'labeller'), (voter, 'labeller')]:
        check(201, api('POST', '/api/v1/project-members', {
            'projectId': project, 'userId': user, 'displayName': user, 'role': role}))
    voters = [voter, 'c05-second-' + suffix, 'c05-third-' + suffix, 'c05-late-' + suffix]
    for user in voters[1:]:
        check(201, api('POST', '/api/v1/project-members', {'projectId': project, 'userId': user, 'displayName': user, 'role': 'labeller'}))
    asset = check(200, api('GET', '/api/v1/assets?' + urlencode({'datasetId': dataset})))['assets'][0]['id']
    record = 'c05-fixture-' + suffix
    check(200, api('POST', '/api/v1/source-records', {
        'assetId': asset, 'sourceRecordId': record, 'sourceDomain': 'sound',
        'labels': {'earlyAnnotation': {'value': 'Bird', 'author': 'PRIVATE_AUTHOR'},
                   'referenceAnswer': {'value': 'HIDDEN_REFERENCE'}}}))
    def task(block):
        draft = {'name': 'C05 ' + suffix, 'description': '', 'domain': 'sound',
                 'instructions': 'Listen and annotate', 'blocks': [block],
                 'policy': {'requiredIndependentVotes': 1, 'blindToOthers': True, 'requiresReview': False}}
        definition = check(201, api('POST', '/api/v1/task-definitions', {'projectId': project, 'draft': draft}))['taskDefinition']
        check(201, api('POST', '/api/v1/task-definitions/' + definition['id'] + '/publish', {
            'expectedRevision': 1, 'expectedPublishedVersion': 0}))
        return check(201, api('POST', '/api/v1/task-instances', {'projectId': project, 'definitionId': definition['id'],
            'definitionVersion': 1, 'assetId': asset, 'sourceRecordId': record}))['taskInstance']
    def assign(target, user):
        return check(201, api('POST', '/api/v1/assignments', {
            'projectId': project, 'taskInstanceId': target['id'], 'labellerId': user}))['assignment']['id']
    original = task({'id': 'caption', 'type': 'text', 'label': 'Caption', 'required': True})
    source_job = assign(original, author)
    source_revision = check(201, api('POST', '/api/v1/assignments/' + source_job + '/annotation/submit', {
        'labellerId': author, 'expectedRevision': 0, 'answers': {'caption': 'Wind'}}))['annotation']
    voting = task({'id': 'vote', 'type': 'candidate_vote', 'candidateSource': 'set', 'label': 'Best candidate', 'required': True, 'minimumVotes': 3, 'candidateOrigins': ['dataset_annotation', 'submission']})
    job = assign(voting, voter)
    body = {'projectId': project, 'taskInstanceId': voting['id'], 'blockId': 'vote', 'userId': admin,
            'requestId': 'c05-http-' + suffix, 'sources': [
                {'kind': 'dataset_annotation', 'labelId': asset + '::' + record + '::early_annotation'},
                {'kind': 'submission', 'revisionId': source_revision['id'], 'blockId': 'caption'}]}
    check(422, api('POST', '/api/v1/candidate-sets', {**body, 'sources': [
        {**body['sources'][0], 'labelId': asset + '::' + record + '::reference_answer'}, body['sources'][1]]}))
    inventory = check(200, api('GET', '/api/v1/candidate-sets/sources?' + urlencode({'projectId': project, 'userId': admin, 'taskInstanceId': voting['id'], 'blockId': 'vote'})))
    assert len(inventory['sources']) == 2
    assert 'HIDDEN_REFERENCE' not in str(inventory) and 'PRIVATE_AUTHOR' not in str(inventory)
    created = check(201, api('POST', '/api/v1/candidate-sets', body))['candidateSet']
    assert check(200, api('POST', '/api/v1/candidate-sets', body))['candidateSet']['id'] == created['id']
    path = '/api/v1/assignments/' + job
    view = check(200, api('GET', path + '/candidates?' + urlencode({'labellerId': voter})))['candidateSets']['vote']
    assert [entry['value'] for entry in view['candidates']] == ['Bird', 'Wind']
    assert all(set(entry) == {'id', 'value'} for entry in view['candidates'])
    check(403, api('GET', path + '/candidates?' + urlencode({'labellerId': author})))
    selected = {'candidateSetSnapshotId': view['id'], 'selectedCandidateId': view['candidates'][1]['id']}
    write = {'labellerId': voter, 'expectedRevision': 0, 'answers': {'vote': selected}}
    check(422, api('POST', path + '/annotation/draft', {**write, 'answers': {'vote': {
        **selected, 'selectedCandidateId': str(uuid.uuid4())}}}))
    check(201, api('POST', path + '/annotation/draft', write))
    check(201, api('POST', path + '/annotation/submit', {**write, 'expectedRevision': 1}))
    check(409, api('POST', path + '/annotation/submit', {**write, 'expectedRevision': 1}))
    current = check(200, api('GET', path + '/annotation?' + urlencode({'labellerId': voter})))['current']
    assert current['status'] == 'submitted' and current['answers']['vote'] == selected
    history = check(200, api('GET', path + '/annotation/revisions?' + urlencode({'labellerId': voter})))['revisions']
    assert len(history) == 2 and all(entry['answers']['vote'] == selected for entry in history)
    result_path = '/api/v1/candidate-sets/' + view['id'] + '/result'
    actor = {'projectId': project, 'userId': admin}
    pending = check(200, api('POST', result_path, actor))['result']
    assert pending['status'] == 'pending_votes' and pending['totalVotes'] == 1
    for index, user in enumerate(voters[1:3]):
        next_job = assign(voting, user)
        choice = view['candidates'][index]['id']
        check(201, api('POST', '/api/v1/assignments/' + next_job + '/annotation/submit', {
            'labellerId': user, 'expectedRevision': 0, 'answers': {'vote': {**selected, 'selectedCandidateId': choice}}}))
    preview = check(200, api('GET', result_path + '?' + urlencode(actor)))['result']
    assert preview['status'] == 'accepted' and preview['persisted'] is False
    result = check(200, api('POST', result_path, actor))['result']
    assert result['persisted'] is True and result['status'] == 'accepted' and result['totalVotes'] == 3
    assert result['accepted']['value'] == 'Wind' and result['accepted']['source']['revisionId'] == source_revision['id']
    assert check(200, api('POST', result_path, actor))['result'] == result
    check(403, api('GET', result_path + '?' + urlencode({**actor, 'userId': voter})))
    closed = check(200, api('GET', path + '/candidates?' + urlencode({'labellerId': voter})))['candidateSets']['vote']
    assert closed['closed'] is True and all(key not in closed for key in ['counts', 'accepted', 'votes'])
    late = assign(voting, voters[3])
    check(409, api('POST', '/api/v1/assignments/' + late + '/annotation/submit', {
        'labellerId': voters[3], 'expectedRevision': 0, 'answers': {'vote': selected}}))
    # Independent 1–1 tie: no arbitrary winner or terminal closing.
    tie = task({'id': 'vote', 'type': 'candidate_vote', 'candidateSource': 'set', 'label': 'Tie', 'required': True, 'minimumVotes': 2})
    tie_set = check(201, api('POST', '/api/v1/candidate-sets', {**body, 'taskInstanceId': tie['id'], 'requestId': 'tie-' + suffix}))['candidateSet']
    for index, user in enumerate(voters[:2]):
        tied_job = assign(tie, user)
        tied_view = check(200, api('GET', '/api/v1/assignments/' + tied_job + '/candidates?' + urlencode({'labellerId': user})))['candidateSets']['vote']
        check(201, api('POST', '/api/v1/assignments/' + tied_job + '/annotation/submit', {
            'labellerId': user, 'expectedRevision': 0, 'answers': {'vote': {'candidateSetSnapshotId': tied_view['id'], 'selectedCandidateId': tied_view['candidates'][index]['id']}}}))
    tied_result = check(200, api('POST', '/api/v1/candidate-sets/' + tie_set['id'] + '/result', actor))['result']
    assert tied_result['status'] == 'pending_adjudication' and 'accepted' not in tied_result
    print('PASS C05 local D1 HTTP: source inventory, publication, draft/submit/reopen, majority, tie, immutable result provenance, closed-vote rejection and privacy')
    print('Voting assignment:', job, '| candidate set:', view['id'], '| accepted result:', result['id'], '| tie:', tied_result['id'])
