#!/usr/bin/env python3
"""C02 live source adapter regression; writes synthetic imported records only.

Use ONLY a disposable local D1 server (never precious copied development state):
  python3 scripts/test_source_fields_http.py PROJECT_UUID DATASET_UUID \
    http://127.0.0.1:5181 --disposable-local

Retains imported MMAU rows and original labels. New fixtures use unique record
IDs on existing assets. All read/write operations go through real local APIs.
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
    if not base.startswith(('http://localhost:', 'http://127.0.0.1:')):
        sys.exit('A disposable localhost server is required.')
    test_annotations.BASE = base.rstrip('/')
    assets = check(200, api('GET', '/api/v1/assets?' + urlencode({'datasetId': dataset})))['assets']
    assert len(assets) >= 2, 'Two audio asset metadata records required.'
    suffix = uuid.uuid4().hex[:8]
    admin, worker = 'c02-admin-' + suffix, 'c02-worker-' + suffix
    for user, role in [(admin, 'admin'), (worker, 'labeller')]:
        check(201, api('POST', '/api/v1/project-members', {
            'projectId': project, 'userId': user, 'displayName': user, 'role': role}))
    record = 'c02-shared-' + suffix
    # External ID repeats on two recordings. The compound source identity must
    # preserve each recording's distinct question/choices and private originals.
    for index, asset in enumerate(assets[:2], 1):
        check(200, api('POST', '/api/v1/source-records', {
            'assetId': asset['id'], 'sourceRecordId': record, 'sourceDomain': 'sound',
            'question': 'Synthetic question {}'.format(index),
            'choices': ['A{}'.format(index), 'B', 'C', 'D'],
            'metadata': {'split': 'test', 'nested': {'answer': 'PRIVATE_METADATA_' + suffix}},
            'labels': {'referenceAnswer': {'value': 'HIDDEN_REFERENCE_' + suffix},
                       'earlyAnnotation': {'transcript': 'HIDDEN_EARLY_' + suffix,
                                           'nested': ['private-original', index]}}}))

    def source(expected=200, **patch):
        query = {'projectId': project, 'datasetId': dataset, 'userId': admin,
                 'recordId': record, 'view': 'admin', 'assetId': assets[0]['id']}
        query.update(patch)
        query = {key: value for key, value in query.items() if value is not None}
        return check(expected, api('GET', '/api/v1/source-fields?' + urlencode(query)))

    for index, asset in enumerate(assets[:2], 1):
        restricted = source(assetId=asset['id'])['source']
        fields = {entry['field']['id']: entry for entry in restricted['fields']}
        assert fields['question']['value'] == 'Synthetic question {}'.format(index)
        assert fields['choices']['value'] == ['A{}'.format(index), 'B', 'C', 'D']
        assert fields['reference_answer']['value']['value'] == 'HIDDEN_REFERENCE_' + suffix
        assert fields['early_annotation']['value']['nested'] == ['private-original', index]
        assert fields['metadata']['value']['nested']['answer'] == 'PRIVATE_METADATA_' + suffix
        for field_id in ['reference_answer', 'early_annotation', 'metadata']:
            assert fields[field_id]['field']['visibility'] == 'admin'
            identity = fields[field_id]['provenance']
            assert identity['assetId'] == asset['id'] and identity['datasetId'] == dataset
            assert identity['recordId'] == record and identity['sourceRecordId'] == asset['id'] + '::' + record
            assert identity['sourceUpdatedAt']
        assert fields['reference_answer']['provenance']['labelUpdatedAt']
        projected = source(userId=worker, view='worker', assetId=asset['id'])['source']
        assert [field['field']['id'] for field in projected['fields']] == ['question', 'choices']
        assert set(projected) == {'audioUrl', 'fields'}
        serialized = json.dumps(projected)
        for forbidden in ['HIDDEN_', 'PRIVATE_', 'metadata', 'reference_answer', 'early_annotation',
                          'sourceRecordId', 'labelId', 'labelProvenance']:
            assert forbidden not in serialized
        listing = check(200, api('GET', '/api/v1/source-records?' + urlencode({'assetId': asset['id']})))
        assert all(row['metadata'] == {} for row in listing['sourceRecords'])
        assert 'PRIVATE_METADATA_' not in json.dumps(listing)
    print('PASS HTTP two scoped records: distinct public fields, exact original annotations/provenance, worker and legacy metadata privacy')

    source(404, assetId=None)  # ambiguous external ID
    source(404, assetId=str(uuid.uuid4()))
    source(404, recordId='missing-' + suffix)
    source(404, userId=worker, view='admin')
    source(404, userId='non-member-' + suffix)
    source(400, assetId='bad')
    source(400, datasetId='bad')
    source(400, recordId='x' * 201)
    source(400, userId='x' * 129)
    foreign = check(201, api('POST', '/api/v1/projects', {
        'name': 'C02 foreign fixture ' + suffix, 'slug': 'c02-foreign-' + suffix}))['project']
    foreign_dataset = check(201, api('POST', '/api/v1/datasets', {
        'projectId': foreign['id'], 'name': 'Foreign', 'version': '1', 'description': ''}))['dataset']
    source(404, projectId=foreign['id'])
    source(404, datasetId=foreign_dataset['id'])
    print('PASS HTTP uniform 404 wrong asset/project/dataset/role/missing/ambiguous; 400 malformed requests')

    # Observe two pre-existing MMAU records through the same worker adapter.
    # Do not print questions, labels or restricted payloads into evidence logs.
    observed = []
    for asset in assets[:2]:
        listing = check(200, api('GET', '/api/v1/source-records?' + urlencode({'assetId': asset['id']})))['sourceRecords']
        original = next(row for row in listing if row['sourceRecordId'] != record and len(row.get('choices') or []) == 4)
        projected = source(userId=worker, view='worker', recordId=original['sourceRecordId'], assetId=asset['id'])['source']
        fields = {entry['field']['id']: entry['value'] for entry in projected['fields']}
        assert fields['question'] == original['question'] and fields['choices'] == original['choices']
        observed.append(fields)
    assert observed[0]['question'] != observed[1]['question']
    print('PASS HTTP two existing MMAU records: projected values match stored question/choices (contents redacted)')
    print(json.dumps({'projectId': project, 'datasetId': dataset, 'recordId': record,
                      'assetIds': [asset['id'] for asset in assets[:2]], 'admin': admin, 'worker': worker}, indent=2))
