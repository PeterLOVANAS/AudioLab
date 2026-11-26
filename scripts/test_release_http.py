#!/usr/bin/env python3
"""R02B actual Worker acceptance, using only an init_local-managed temp root.

Phases: prepare (server up), provision (server stopped), exercise (server up),
verify (repeat after browser work/server restart). No schema changes or copied
presentation state. Credentials and artifacts stay private outside the repo.
"""
import argparse
from contextlib import ExitStack
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import uuid
import zipfile
from local_admin_api import LocalAdminAPI
from import_labellers import find_database
from release_fixture import GROUND_INTERVALS, draft, generate, ground_block, scenarios


def private_json(path, data):
    fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as file: json.dump(data, file, indent=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-root', required=True, type=Path)
    parser.add_argument('--base-url', default='http://127.0.0.1:5202')
    parser.add_argument('--phase', choices=['prepare', 'provision', 'exercise', 'legacy-seed', 'legacy-exercise', 'verify'], required=True)
    parser.add_argument('--server-stopped', action='store_true')
    args = parser.parse_args()
    root = args.state_root.resolve(); repo = Path(__file__).resolve().parents[1]
    assert Path(tempfile.gettempdir()).resolve() in root.parents and repo not in root.parents
    environment = json.loads((root / 'environment.json').read_text())
    assert environment['kind'] == 'audiolab.local-environment/1' and environment['status'] == 'ready'
    assert args.base_url == 'http://127.0.0.1:5202', 'Only the isolated acceptance origin is supported'
    fixture_file = root / 'R02B_FIXTURE.json'
    fixture = json.loads(fixture_file.read_text()) if fixture_file.exists() else {'kind': 'audiolab.r02b/1', 'scenarios': {}}
    assert fixture['kind'] == 'audiolab.r02b/1'
    def save(): private_json(fixture_file, fixture)
    def command(script, *arguments):
        subprocess.run([sys.executable, '-B', str(repo / 'scripts' / script), *map(str, arguments)], check=True, cwd=repo)
    def call(client, method, endpoint, body=None, status=200):
        kwargs = {'json': body} if body is not None else {}
        response = client.request(method, '/api/v1/' + endpoint, **kwargs)
        assert response.status_code == status, (method, endpoint, response.status_code, response.text[:500])
        return response.json()
    if args.phase == 'legacy-seed':
        assert args.server_stopped, 'Stop the disposable server before historical fixture reconstruction'
        if 'legacy' in fixture['scenarios']: print('Retaining historical fixture'); return
        # New candidate ballots are intentionally deprecated. Reconstruct one
        # historical job in this marked temporary environment; never bypass the
        # production publication/allocation gates or edit an existing snapshot.
        previous = fixture['scenarios']['negation']; jid, did = str(uuid.uuid4()), str(uuid.uuid4())
        protocol = draft('R02B historical example ballot', [{'id': 'vote', 'type': 'candidate_vote',
            'label': 'Historical ballot', 'required': True, 'candidateSource': 'example',
            'candidatePrompt': 'Archived synthetic tone caption',
            'options': [{'id': 'yes', 'label': 'Agree'}, {'id': 'no', 'label': 'Disagree'}]}])
        with sqlite3.connect(find_database(root)) as db:
            backup = sqlite3.connect(root / 'before-legacy-fixture.sqlite'); db.backup(backup); backup.close()
            os.chmod(root / 'before-legacy-fixture.sqlite', 0o600)
            db.row_factory = sqlite3.Row; db.execute('PRAGMA foreign_keys=ON')
            def insert(table, row):
                # Table/column names are fixed repository schema, never CLI input.
                db.execute(f'INSERT INTO {table} ({",".join(row)}) VALUES ({",".join("?" for _ in row)})', list(row.values()))
            db.execute('INSERT INTO task_definitions(id,project_id,draft_json,published_version) VALUES(?,?,?,1)', (did, fixture['projectId'], json.dumps(protocol)))
            db.execute('INSERT INTO task_definition_versions(definition_id,version,definition_json) VALUES(?,1,?)', (did, json.dumps(protocol)))
            job = dict(db.execute('SELECT * FROM annotation_jobs WHERE id=?', (previous['jobId'],)).fetchone())
            plan = json.loads(job['plan_json']); plan['input'].update(jobId=jid, definitionId=did, name='R02B historical ballot')
            plan['hash'] = hashlib.sha256(json.dumps(plan['input'], sort_keys=True).encode()).hexdigest()
            job.update(id=jid, definition_id=did, name=plan['input']['name'], plan_json=json.dumps(plan), plan_hash=plan['hash'])
            insert('annotation_jobs', job)
            for table in ['annotation_job_items', 'annotation_job_workers']:
                for record in db.execute('SELECT * FROM ' + table + ' WHERE job_id=?', (previous['jobId'],)).fetchall():
                    row = dict(record); row['job_id'] = jid; insert(table, row)
            task_ids = {}; allocated = []
            for record in db.execute('SELECT a.*,ja.item_key FROM assignments a JOIN annotation_job_assignments ja ON ja.assignment_id=a.id WHERE ja.job_id=?', (previous['jobId'],)).fetchall():
                row = dict(record); old_task = row['task_instance_id']; key = row.pop('item_key')
                if old_task not in task_ids:
                    task = dict(db.execute('SELECT * FROM task_instances WHERE id=?', (old_task,)).fetchone())
                    task_ids[old_task] = str(uuid.uuid4()); task.update(id=task_ids[old_task], definition_id=did, instance_key='historical-r02b:' + jid)
                    insert('task_instances', task)
                    for asset in db.execute('SELECT * FROM task_instance_audio_slots WHERE task_instance_id=?', (old_task,)).fetchall():
                        copied = dict(asset); copied['task_instance_id'] = task['id']; insert('task_instance_audio_slots', copied)
                row.update(id=str(uuid.uuid4()), task_instance_id=task_ids[old_task], status='assigned', started_at=None, submitted_at=None, reviewed_at=None)
                insert('assignments', row)
                insert('annotation_job_assignments', {'job_id': jid, 'assignment_id': row['id'], 'item_key': key})
                allocated.append({'id': row['id'], 'userId': row['labeller_user_id']})
            assert not db.execute('PRAGMA foreign_key_check').fetchall()
        fixture['scenarios']['legacy'] = {'jobId': jid, 'definitionId': did, 'audioCount': 1, 'assignments': allocated,
            'answers': {worker['user_id']: {'vote': {'value': 'no' if i == 1 else 'yes'}} for i, worker in enumerate(fixture['workers'])}, 'historicalFixture': True}
        save(); print('PASS historical ballot fixture reconstructed only in disposable state; no submitted values seeded'); return
    if args.phase == 'provision':
        assert args.server_stopped, 'Stop the DEV server before offline account provisioning'
        users = [{'username': 'r02b-' + name.lower(), 'display_name': name,
                  'user_id': str(uuid.uuid5(uuid.UUID(fixture['projectId']), name))}
                 for name in ['Alice', 'Bob', 'Chai']]
        manifest = root / 'labellers-manifest.json'
        private_json(manifest, {'schema_version': 1, 'labellers': users})
        command('import_labellers.py', '--state-root', root, '--manifest', manifest,
                '--project-id', fixture['projectId'], '--credentials-out', root / 'labellers-private.json', '--import', '--server-stopped')
        fixture['workers'] = users; save(); print('PASS controlled independent labeller provisioning'); return
    with ExitStack() as stack:
        admin = stack.enter_context(LocalAdminAPI(args.base_url, credentials_file=root / 'admin-credentials.json'))
        if args.phase == 'prepare':
            if 'projectId' not in fixture:
                # tempfile suffixes may contain underscores, which are correctly
                # forbidden in project slugs. Hash the unique disposable root
                # instead of making acceptance depend on a random directory name.
                slug = 'r02b-' + uuid.uuid5(uuid.NAMESPACE_URL, str(root)).hex[:12]
                created = call(admin, 'POST', 'projects', {'name': 'R02B Release Acceptance', 'slug': slug}, 201)
                fixture['projectId'] = created['project']['id']; save()
            pid = fixture['projectId']
            if not (root / 'data').exists(): generate(root / 'data')
            command('import_dataset.py', '--base-url', args.base_url, '--project-id', pid,
                '--create-dataset', 'R02B ten-second tones', '--adapter', 'canonical',
                '--manifest', root / 'data/manifest.json', '--root', root / 'data/audio',
                '--credentials-file', root / 'admin-credentials.json', '--output', root / 'import', '--import')
            report = json.loads((root / 'import/report.json').read_text())
            fixture['datasetId'] = report['datasetId']
            fixture['items'] = call(admin, 'GET', f'team-jobs?action=items&projectId={pid}&datasetId={report["datasetId"]}')['items']
            assets = call(admin, 'GET', 'assets?datasetId=' + report['datasetId'])['assets']
            assert len(assets) == 2 and all(asset['durationSeconds'] == 10 for asset in assets)
            fixture['assets'] = assets
            if 'browserDefinitionId' not in fixture:
                browser = draft('R02B Browser Grounding draft', [ground_block(), {'id': 'note', 'type': 'text', 'label': 'Listening note', 'required': True}])
                fixture['browserDefinitionId'] = call(admin, 'POST', 'task-definitions', {'projectId': pid, 'draft': browser}, 201)['taskDefinition']['id']
            save(); print('PASS authenticated project creation, canonical CLI import, exact assets/durations and editable browser draft'); return
        pid, dataset = fixture['projectId'], fixture['datasetId']
        clients = [stack.enter_context(LocalAdminAPI(args.base_url, username=row['username'], credentials_file=root / 'labellers-private.json')) for row in fixture['workers']]
        ids = [client.user_id for client in clients]
        if args.phase == 'legacy-exercise':
            row = fixture['scenarios']['legacy']
            for client in clients:
                aid = next(a['id'] for a in row['assignments'] if a['userId'] == client.user_id)
                endpoint = f'assignments/{aid}/annotation'; answer = row['answers'][client.user_id]
                loaded = call(client, 'GET', 'assignments/' + aid)
                assert 'R02B_PRIVATE_' not in json.dumps(loaded)
                call(client, 'POST', endpoint + '/draft', {'labellerId': client.user_id, 'expectedRevision': 0, 'answers': answer}, 201)
                call(client, 'POST', endpoint + '/submit', {'labellerId': client.user_id, 'expectedRevision': 1, 'answers': answer}, 201)
                assert call(client, 'GET', endpoint + '?labellerId=' + client.user_id)['current']['answers'] == answer
            row['exercised'] = True; save(); print('PASS legacy ballot HTTP validation, draft/final persistence and reloading')
        if args.phase == 'exercise':
            if 'teamId' not in fixture:
                team = call(admin, 'POST', 'worker-profiles?action=team', {'projectId': pid, 'name': 'R02B independent labellers', 'memberIds': ids})
                fixture['teamId'] = team['teamId']; save()
            by_name = {asset['originalPath']: asset for asset in fixture['assets']}
            primary = by_name['primary.wav']['id']
            primary_item = next(item for item in fixture['items'] if item['assetId'] == primary)
            for name, scenario in scenarios().items():
                if name in fixture['scenarios']:
                    row = fixture['scenarios'][name]
                    if row.get('exercised'):
                        print('Retaining existing scenario:', name); continue
                    launched = {'assignments': row['assignments']}
                    body = {'jobId': row['jobId']}
                else:
                    definition = call(admin, 'POST', 'task-definitions', {'projectId': pid, 'draft': draft('R02B ' + name, scenario['blocks'])}, 201)['taskDefinition']
                    call(admin, 'POST', f'task-definitions/{definition["id"]}/publish', {'expectedRevision': 1, 'expectedPublishedVersion': 0}, 201)
                    # Advance the mutable draft after publishing; active jobs must
                    # still use v1 and must not reinterpret these immutable answers.
                    call(admin, 'PUT', 'task-definitions/' + definition['id'], {'expectedRevision': 1, 'draft': draft('Unpublished edit ' + name, scenario['blocks'])})
                    count = 2 if scenario.get('twoAudio') else 1
                    selected = fixture['items'] if count == 2 else [primary_item]
                    body = {'jobId': str(uuid.uuid4()), 'projectId': pid, 'name': 'R02B ' + name,
                            'teamId': fixture['teamId'], 'datasetId': dataset, 'definitionId': definition['id'], 'definitionVersion': 1,
                            'mode': 'voting', 'seed': 'r02b-' + name, 'sampleCount': count, 'itemKeys': [item['key'] for item in selected], 'workerIds': ids}
                    plan = call(admin, 'POST', 'team-jobs?action=preview', body)['plan']
                    launched = call(admin, 'POST', 'team-jobs?action=launch', {**plan['input'], 'expectedHash': plan['hash']})
                    # Launch replay must return the existing frozen allocation.
                    replay = call(admin, 'POST', 'team-jobs?action=launch', {**plan['input'], 'expectedHash': plan['hash']})
                    assert {a['id'] for a in replay['assignments']} == {a['id'] for a in launched['assignments']}
                    assert len(launched['assignments']) == 3
                    row = {'jobId': body['jobId'], 'definitionId': definition['id'], 'audioCount': count,
                           'assignments': launched['assignments'], 'answers': dict(zip(ids, scenario['answers']))}
                    fixture['scenarios'][name] = row; save()
                result_url = f'team-jobs?action=results&projectId={pid}&jobId={body["jobId"]}'
                partial = call(admin, 'GET', result_url)
                assert not partial['complete'] and partial['workerSubmissions'] == 0 and partial['blocks'] == []
                for index, client in enumerate(clients):
                    user = client.user_id; assignment = next(a for a in launched['assignments'] if a['userId'] == user)
                    aid = assignment['id']; endpoint = f'assignments/{aid}/annotation'
                    loaded = call(client, 'GET', 'assignments/' + aid)['taskInstance']
                    assert 'R02B_PRIVATE_' not in json.dumps(loaded)
                    assert loaded['definition']['version'] == 1
                    if name == 'preannotated': assert loaded['initialAnswers']['ground']['tiers']['events'][0]['start'] == 0
                    if name == 'speech': assert loaded['initialAnswers']['transcript'] == 'A synthetic recording.'
                    initial = {'ground': [{'tiers': {'events': []}}, {'tiers': {'events': []}}]} if name == 'grounding-multi' else {}
                    call(client, 'POST', endpoint + '/draft', {'labellerId': user, 'expectedRevision': 0, 'answers': initial}, 201)
                    answers = scenario['answers'][index]
                    call(client, 'POST', endpoint + '/draft', {'labellerId': user, 'expectedRevision': 1, 'answers': answers}, 201)
                    call(client, 'POST', endpoint + '/draft', {'labellerId': user, 'expectedRevision': 1, 'answers': answers}, 409)
                    assert call(client, 'GET', endpoint + '?labellerId=' + user)['current']['answers'] == answers
                    call(client, 'POST', endpoint + '/submit', {'labellerId': user, 'expectedRevision': 2, 'answers': {'unknown': 'invalid'}}, 422)
                    call(client, 'POST', endpoint + '/submit', {'labellerId': ids[(index + 1) % 3], 'expectedRevision': 2, 'answers': answers}, 403)
                    call(client, 'POST', endpoint + '/submit', {'labellerId': user, 'expectedRevision': 2, 'answers': answers}, 201)
                    call(client, 'POST', endpoint + '/submit', {'labellerId': user, 'expectedRevision': 3, 'answers': answers}, 409)
                    call(client, 'POST', endpoint + '/draft', {'labellerId': user, 'expectedRevision': 3, 'answers': answers}, 409)
                    history = call(client, 'GET', endpoint + '/revisions?labellerId=' + user)['revisions']
                    assert [r['status'] for r in history] == ['draft', 'draft', 'submitted']
                    assert [r['answers'] for r in history] == [initial, answers, answers]
                    call(clients[(index + 1) % 3], 'GET', 'assignments/' + aid, status=403)
                    if index < 2: assert not call(admin, 'GET', result_url)['complete']
                row['exercised'] = True; save(); print('PASS persisted scenario:', name, flush=True)
        # Every completed scenario is re-read; this phase can be repeated after
        # stopping/restarting Vite to establish persistence without writing finals.
        for name, row in fixture['scenarios'].items():
            assert row.get('exercised'), 'A prior scenario failed before completion: ' + name
            results = call(admin, 'GET', f'team-jobs?action=results&projectId={pid}&jobId={row["jobId"]}')
            assert results['complete'] and results['remaining'] == 0
            assert results['workerSubmissions'] == 3 and results['expectedAssignments'] == 3
            assert results['uniqueAudioItems'] == row['audioCount'] and results['sourceItems'] == row['audioCount']
            if name == 'grounding':
                item = results['items'][0]
                assert len(item['pairs']) == 3 and item['eligiblePairs'] == 3 and item['validObservations'] == 3
                assert all(abs(pair['score'] - 1/3) < 1e-12 for pair in item['pairs'])
                assert abs(item['mean'] - 1/3) < 1e-12 and item['excludedPairs'] == 0
                actual = {item['observations'][track['observation']]['workerId']: [(event['start'], event['end']) for event in track['events']] for track in item['tracks']}
                expected = {user: [(event['start'], event['end']) for event in answer['ground']['tiers']['events']] for user, answer in row['answers'].items()}
                assert actual == expected
            if name == 'grounding-multi':
                assert len(results['items']) == 2
                assert sorted(round(item['mean'], 12) for item in results['items']) == [round(1/3, 12), 1]
                assert all(item['eligiblePairs'] == 3 for item in results['items'])
                assert abs(results['blocks'][0]['meanSimilarity'] - 2/3) < 1e-12
            if name == 'grounding-empty-missing':
                item = results['items'][0]
                assert item['eligiblePairs'] == 1 and item['excludedPairs'] == 2 and item['mean'] == 0
                assert sorted(o['state'] for o in item['observations']) == ['empty', 'missing', 'valid']
            if name == 'grounding-absence':
                item = results['items'][0]
                assert item['eligiblePairs'] == 0 and item['excludedPairs'] == 3 and item['absencePairs'] == 3 and item['mean'] is None
            exported = call(admin, 'GET', f'research-export?projectId={pid}&jobId={row["jobId"]}&format=json')
            assert exported['analytics'] == results and 'R02B_PRIVATE_' not in json.dumps(exported)
            for annotation in exported['tasks'][0]['annotations']: assert annotation['answers'] == row['answers'][annotation['workerId']]
            for format in ['json-zip', 'audio-zip']:
                response = admin.request('GET', f'/api/v1/research-export?projectId={pid}&jobId={row["jobId"]}&format={format}')
                assert response.status_code == 200
                archive = zipfile.ZipFile(io.BytesIO(response.content)); assert archive.testzip() is None
                archived = json.loads(archive.read('job.json'))
                # Each independent export has its own creation timestamp. All
                # persisted annotations/analytics must otherwise be identical.
                assert archived.pop('generatedAt') and exported.get('generatedAt')
                assert archived == {key: value for key, value in exported.items() if key != 'generatedAt'}
                for asset in fixture['assets']:
                    file = 'audio/' + asset['id'] + '.wav'
                    if file in archive.namelist():
                        assert hashlib.sha256(archive.read(file)).digest() == hashlib.sha256((root / 'data/audio' / asset['originalPath']).read_bytes()).digest()
                (root / (name + '-' + format + '.zip')).write_bytes(response.content)
            old = row.get('results')
            if old is not None: assert old == results, 'Reload/restart changed persisted analytics: ' + name
            row['results'] = results
            detail = call(admin, 'GET', f'team-jobs?action=detail&projectId={pid}&jobId={row["jobId"]}')
            assert detail['summary']['submitted'] == 3 and detail['summary']['fullyLabelledItems'] == row['audioCount']
        if fixture.get('browserJobId'):
            browser_result = call(admin, 'GET', f'team-jobs?action=results&projectId={pid}&jobId={fixture["browserJobId"]}')
            assert browser_result['complete'] and browser_result['workerSubmissions'] == 3
            item = next(item for item in browser_result['items'] if item['block']['id'] == 'ground')
            assert item['eligiblePairs'] == 3 and abs(item['mean'] - 1/3) < 1e-12
            assert all(abs(pair['score'] - 1/3) < 1e-12 for pair in item['pairs'])
            browser_export = call(admin, 'GET', f'research-export?projectId={pid}&jobId={fixture["browserJobId"]}&format=json')
            assert browser_export['analytics'] == browser_result
            for annotation in browser_export['tasks'][0]['annotations']:
                index = ids.index(annotation['workerId'])
                assert [(event['start'], event['end']) for event in annotation['answers']['ground']['tiers']['events']] == GROUND_INTERVALS[index]
            fixture['browserResults'] = browser_result
        with sqlite3.connect(find_database(root).as_uri() + '?mode=ro', uri=True) as db:
            assert db.execute('PRAGMA foreign_key_check').fetchall() == []
            counts = db.execute('SELECT status,count(*) FROM annotation_revisions GROUP BY status').fetchall()
        fixture['verification'] = {'status': 'PASS', 'scenarios': list(fixture['scenarios']), 'revisionCounts': dict(counts)}
        save(); print('PASS persisted results, exact grounding IoU, JSON/ZIP raw/analytics equality and read-only D1 evidence')


if __name__ == '__main__': main()
