#!/usr/bin/env python3
"""Add identity/team-job schema + ten synthetic worker accounts to a disposable
copy only. Run with the server stopped. Never applies migrations to preserved D1.
"""
import argparse
import hashlib
import json
import os
import pathlib
import secrets
import sqlite3
import subprocess
import tempfile
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-root', required=True)
    parser.add_argument('--include-existing-projects', action='store_true', help='Explicitly grant demo accounts membership in copied projects; disposable state only')
    args = parser.parse_args()
    root = pathlib.Path(args.state_root).resolve()
    repo = pathlib.Path(__file__).resolve().parents[1]
    if not (root / 'DISPOSABLE_DEMO.json').is_file() or pathlib.Path(tempfile.gettempdir()).resolve() not in root.parents or (repo / '.cloudflare').resolve() in root.parents:
        raise SystemExit('Refusing writes: use the new temp copy from prepare_assignment_demo.py, with server stopped.')
    path = None
    for candidate in (root / 'v3/d1').rglob('*.sqlite'):
        con = sqlite3.connect(candidate.resolve().as_uri() + '?mode=ro', uri=True)
        if con.execute("SELECT 1 FROM sqlite_master WHERE name='projects'").fetchone():
            path = candidate
        con.close()
    if not path:
        raise SystemExit('No compatible copied D1 database.')
    con = sqlite3.connect(path)
    if not (root / 'before-team-jobs.sqlite').exists():
        backup = sqlite3.connect(root / 'before-team-jobs.sqlite')
        con.backup(backup)
        backup.close()
    con.execute('PRAGMA foreign_keys=ON')
    for migration in ['0015_team_jobs_identity.sql', '0016_access_token_revocation.sql', '0017_job_archives.sql']:
        if not con.execute('SELECT 1 FROM d1_migrations WHERE name=?', (migration,)).fetchone():
            if migration.startswith('0017'):
                backup=sqlite3.connect(root/'before-job-archives.sqlite');con.backup(backup);backup.close();os.chmod(root/'before-job-archives.sqlite',0o600)
            con.executescript((repo / 'migrations' / migration).read_text())
            con.execute('INSERT INTO d1_migrations(name) VALUES(?)', (migration,))
            con.commit()
    uid = lambda value: str(uuid.uuid5(uuid.NAMESPACE_URL, 'audiolab-team-demo:' + value))
    project, dataset, definition = uid('project'), uid('dataset'), uid('definition')
    con.execute('INSERT INTO projects(id,name,slug) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING', (project, 'Team Jobs Demo', 'team-jobs-demo'))
    con.execute('INSERT INTO datasets(id,project_id,name,version,description) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING', (dataset, project, '10 question items', 'v1', 'Local copied audio links with ten synthetic independent questions.'))
    secret_file = root / 'demo-login.txt'
    if not secret_file.exists() and con.execute("SELECT 1 FROM auth_accounts WHERE user_id='demo-admin'").fetchone():
        raise SystemExit('Existing demo account has no password file. Use a fresh disposable copy; do not reset preserved identities.')
    password = secret_file.read_text().splitlines()[-1] if secret_file.exists() else secrets.token_urlsafe(18)
    people = [('demo-admin', 'Demo Admin', 'admin', '', '', [], 0)]
    names = ['Alice', 'Bob', 'Chai', 'Dao', 'Emi', 'Farah', 'Grace', 'Hana', 'Ian', 'Jin']
    countries = ['Thailand', 'Thailand', 'Thailand', 'Thailand', 'Japan', 'Malaysia', 'United Kingdom', 'Japan', 'United States', 'China']
    for index, name in enumerate(names):
        people.append(('demo-' + name.lower(), name, 'labeller', countries[index], 'Linguist' if index % 2 == 0 else 'Researcher', ['Thai', 'English'] if index < 4 else ['English'], index % 7))
    for user, name, role, country, profession, languages, years in people:
        existing = con.execute('SELECT demo_salt,demo_password_hash FROM auth_accounts WHERE user_id=?', (user,)).fetchone()
        salt = existing[0] if existing and existing[0] else secrets.token_hex(16)
        hashed = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000).hex()
        con.execute('INSERT INTO auth_accounts(user_id,username,display_name,demo_salt,demo_password_hash) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO NOTHING', (user, user, name, salt, hashed))
        con.execute('INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,?) ON CONFLICT(project_id,user_id) DO NOTHING', (project, user, name, role))
        if role == 'labeller':
            con.execute('INSERT INTO worker_profiles(project_id,user_id,country,profession,languages_json,experience_years,metadata_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,user_id) DO NOTHING', (project, user, country, profession, json.dumps(languages), years, json.dumps({'specialty': 'Phonetics' if profession == 'Linguist' else 'Audio research'})))
    if args.include_existing_projects:
        # Explicit local fixture provisioning, never an authorization bypass.
        for (copied_project,) in con.execute('SELECT id FROM projects WHERE id<>?', (project,)).fetchall():
            for user, name, role, country, profession, languages, years in people:
                con.execute('INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,?) ON CONFLICT(project_id,user_id) DO NOTHING', (copied_project,user,name,role))
                if role == 'labeller':
                    con.execute('INSERT INTO worker_profiles(project_id,user_id,country,profession,languages_json,experience_years,metadata_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,user_id) DO NOTHING', (copied_project,user,country,profession,json.dumps(languages),years,'{}'))
    originals = con.execute("SELECT id,original_path,storage_provider,storage_key,mime_type,size_bytes,duration_seconds,sample_rate,channels,sha256 FROM audio_assets WHERE dataset_id<>? AND storage_provider='r2' ORDER BY id LIMIT 2", (dataset,)).fetchall()
    if len(originals) < 2:
        raise SystemExit('The copied state needs two existing R2 audio assets. No media was fabricated or uploaded.')
    for index, original in enumerate(originals):
        asset = uid('audio-' + str(index))
        con.execute('INSERT INTO audio_assets(id,dataset_id,original_path,storage_provider,storage_key,mime_type,size_bytes,duration_seconds,sample_rate,channels,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', (asset, dataset, 'demo-' + str(index) + '.wav', *original[2:]))
        for question in range(5):
            number = index * 5 + question + 1
            record, source_id = 'team-demo-q-' + str(number), uid('item-' + str(number))
            body = {'sample_id': 'sample-' + str(index), 'item_id': 'question-' + str(number), 'source_version': 'v1', 'sample_fields': {'instruction': {'type': 'text', 'visibility': 'worker', 'value': 'Listen independently to this recording.'}}, 'fields': {'question': {'type': 'text', 'visibility': 'worker', 'value': f'Question {number}: which sound category best fits?'}, 'options': {'type': 'choices', 'visibility': 'worker', 'value': [{'id': 'speech', 'label': 'Speech'}, {'id': 'music', 'label': 'Music'}, {'id': 'environment', 'label': 'Environmental sound'}]}}}
            raw = json.dumps(body, sort_keys=True, separators=(',', ':'))
            con.execute("INSERT INTO source_records(id,asset_id,source_record_id,source_domain,canonical_json,canonical_dataset_id,ingestion_hash) VALUES(?,?,?,'sound',?,?,?) ON CONFLICT(id) DO NOTHING", (source_id, asset, record, raw, dataset, hashlib.sha256(raw.encode()).hexdigest()))
    draft = {'name': 'Team sound classification', 'description': 'Synthetic demo questions linked to copied local audio.', 'domain': 'sound', 'instructions': 'Listen independently.', 'instructionBinding': {'kind': 'dataset', 'fieldId': 'sample.instruction', 'type': 'string'}, 'policy': {'requiredIndependentVotes': 1, 'blindToOthers': True, 'requiresReview': False}, 'blocks': [{'id': 'classification', 'type': 'single_choice', 'label': 'Sound category', 'required': True, 'answerAppearance': 'exam', 'sourceBindings': {'label': {'kind': 'dataset', 'fieldId': 'item.question', 'type': 'string'}, 'options': {'kind': 'dataset', 'fieldId': 'item.options', 'type': 'choices'}}}]}
    # Validate the fixture against the real task schema before creating a published snapshot.
    result = subprocess.run(['node', str(repo / 'scripts/validate_team_demo.cjs')], input=json.dumps(draft), text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(result.stderr)
    raw = json.dumps(draft, sort_keys=True)
    con.execute('INSERT INTO task_definitions(id,project_id,draft_json,published_version) VALUES(?,?,?,1) ON CONFLICT(id) DO NOTHING', (definition, project, raw))
    con.execute('INSERT INTO task_definition_versions(definition_id,version,definition_json) VALUES(?,1,?) ON CONFLICT(definition_id,version) DO NOTHING', (definition, raw))
    team = uid('thai-team')
    con.execute('INSERT INTO worker_teams(id,project_id,name,created_by) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING', (team, project, 'Thai annotation team', 'demo-admin'))
    for user in ['demo-alice', 'demo-bob', 'demo-chai', 'demo-dao']:
        con.execute('INSERT INTO worker_team_members(team_id,project_id,user_id) VALUES(?,?,?) ON CONFLICT(team_id,user_id) DO NOTHING', (team, project, user))
    con.commit()
    assert not con.execute('PRAGMA foreign_key_check').fetchall()
    con.close()
    fd = os.open(secret_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write('Local demo only. Admin: demo-admin. Labellers: demo-alice, demo-bob, demo-chai, demo-dao, demo-emi, demo-farah, demo-grace, demo-hana, demo-ian, demo-jin. Shared password on next line.\n' + password + '\n')
    (root / 'TEAM_DEMO.json').write_text(json.dumps({'projectId': project, 'datasetId': dataset, 'definitionId': definition, 'teamId': team}, indent=2))
    print('Seeded Team Jobs Demo with 10 labellers and one admin; existing copied records retained.')
    print('Local credentials file (not printed or committed):', secret_file)
    print(json.dumps({'projectId': project, 'datasetId': dataset, 'definitionId': definition}))


if __name__ == '__main__':
    main()
