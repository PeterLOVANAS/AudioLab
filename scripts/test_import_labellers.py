#!/usr/bin/env python3
"""Focused provisioning tests: real CLI, disposable SQLite and actual Worker hash helper."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
import uuid

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('import_labellers', REPO / 'scripts/import_labellers.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class LabellerImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='audiolab-labeller-import-')
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        folder = self.state / 'v3/d1/miniflare-D1DatabaseObject'
        folder.mkdir(parents=True)
        self.database = folder / 'local.sqlite'
        self.db = sqlite3.connect(self.database)
        self.db.row_factory = sqlite3.Row
        for migration in sorted((REPO / 'migrations').glob('*.sql')):
            self.db.executescript(migration.read_text())
        self.project, self.other = str(uuid.uuid4()), str(uuid.uuid4())
        for project in [self.project, self.other]:
            self.db.execute('INSERT INTO projects(id,name,slug) VALUES(?,?,?)', (project, project, project))
        self.db.commit()
        sqlite3.connect(folder / 'metadata.sqlite').close()
        self.manifest = self.root / 'labellers.json'
        self.output = self.root / 'credentials.json'
        self.person = {'username': 'new-alice', 'display_name': 'Alice', 'country': 'Thailand', 'profession': 'Linguist', 'languages': ['Thai', 'English'], 'experience_years': 3, 'metadata': {'specialty': 'Phonetics'}}
        self.write([self.person])

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def write(self, people):
        self.manifest.write_text(json.dumps({'schema_version': 1, 'labellers': people}))

    def run_cli(self, *options, success=True):
        command = ['python3', str(REPO / 'scripts/import_labellers.py'), '--state-root', str(self.state), '--manifest', str(self.manifest), '--project-id', self.project, *options]
        result = subprocess.run(command, text=True, capture_output=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertEqual(result.returncode, 2, result.stdout)
        return result

    def apply(self, *options, success=True):
        return self.run_cli('--import', '--server-stopped', '--credentials-out', str(self.output), *options, success=success)

    def count(self):
        return self.db.execute('SELECT COUNT(*) FROM auth_accounts').fetchone()[0]

    def test_read_only_default_and_project_discovery(self):
        before = hashlib.sha256(self.database.read_bytes()).hexdigest()
        result = self.run_cli()
        self.assertEqual(result['mode'], 'dry-run')
        self.assertEqual(result['counts'], {'new_accounts': 1, 'new_memberships': 1, 'new_profiles': 1, 'updated_profiles': 0})
        self.assertEqual(self.count(), 0)
        self.assertFalse(self.output.exists())
        self.assertFalse((self.state / 'labeller-backups').exists())
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), before)
        listed = self.run_cli('--list-projects')
        self.assertEqual({p['id'] for p in listed['projects']}, {self.project, self.other})

    def test_import_hash_compatibility_private_backup_and_idempotency(self):
        result = self.apply()
        credentials = json.loads(self.output.read_text())['accounts'][0]
        account = self.db.execute('SELECT * FROM auth_accounts').fetchone()
        self.assertEqual(account['user_id'], credentials['user_id'])
        self.assertEqual(account['demo_password_hash'], hashlib.pbkdf2_hmac('sha256', credentials['password'].encode(), account['demo_salt'].encode(), 100000).hex())
        # Execute the real TypeScript helper, not just Python's mirrored algorithm.
        node = r"""
const fs=require('node:fs'),path=require('node:path'),ts=require('@typescript/typescript6');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
// Load the helper's real local dependencies too: R03 introduced a shared
// configuration import. Node does not resolve the app's @/ TypeScript alias.
const cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file).exports;
 const mod={exports:{}};cache.set(file,mod);
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText.replaceAll('import.meta.env.DEV','true');
 new Function('require','module','exports',code)(name=>name.startsWith('@/')?load(path.resolve(name.slice(2)+'.ts')):require(name),mod,mod.exports);
 return mod.exports;
}
load(path.resolve('lib/backend/auth/identity.ts')).demoPasswordHash(input.password,input.salt).then(value=>{if(value!==input.hash)process.exitCode=1;});
"""
        hashed = subprocess.run(['node', '-e', node], input=json.dumps({'password': credentials['password'], 'salt': account['demo_salt'], 'hash': account['demo_password_hash']}), text=True, capture_output=True, cwd=REPO)
        self.assertEqual(hashed.returncode, 0, hashed.stderr)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        backup = Path(result['backup'])
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(backup) as saved:
            self.assertEqual(saved.execute('SELECT COUNT(*) FROM auth_accounts').fetchone()[0], 0)
            self.assertEqual(saved.execute('SELECT COUNT(*) FROM projects').fetchone()[0], 2)
        member = self.db.execute('SELECT role FROM project_members').fetchone()
        profile = self.db.execute('SELECT * FROM worker_profiles').fetchone()
        self.assertEqual(member['role'], 'labeller')
        self.assertEqual(profile['profession'], 'Linguist')
        self.assertEqual(json.loads(profile['languages_json']), ['Thai', 'English'])
        again = self.apply()
        self.assertFalse(any(again['counts'].values()))
        self.assertNotIn('credentials_file', again)
        self.assertEqual(self.count(), 1)
        self.assertEqual(len(list(backup.parent.glob('*.sqlite'))), 1)
        self.assertEqual(dict(self.db.execute('SELECT * FROM auth_accounts').fetchone()), dict(account))

    def test_explicit_profile_update_and_multiple_projects(self):
        self.apply()
        original = dict(self.db.execute('SELECT * FROM auth_accounts').fetchone())
        updated = {**self.person, 'profession': 'Researcher'}
        self.write([updated])
        self.apply(success=False)
        self.assertEqual(self.db.execute('SELECT profession FROM worker_profiles').fetchone()[0], 'Linguist')
        result = self.run_cli('--import', '--server-stopped', '--update-profiles', '--project-id', self.other)
        self.assertEqual(result['counts']['updated_profiles'], 1)
        self.assertEqual(result['counts']['new_memberships'], 1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM project_members').fetchone()[0], 2)
        self.assertEqual(dict(self.db.execute('SELECT * FROM auth_accounts').fetchone()), original)
        # An omitted profile does not erase earlier metadata on a reimport.
        self.write([{'username': 'new-alice', 'display_name': 'Alice'}])
        self.assertFalse(any(self.run_cli()['counts'].values()))
        self.assertEqual(json.loads(self.db.execute('SELECT metadata_json FROM worker_profiles LIMIT 1').fetchone()[0]), {'specialty': 'Phonetics'})

    def test_stopped_server_and_no_overwrite_guards(self):
        self.run_cli('--import', success=False)
        self.assertEqual(self.count(), 0)
        self.output.write_text('do not overwrite')
        self.apply(success=False)
        self.assertEqual(self.output.read_text(), 'do not overwrite')
        self.assertEqual(self.count(), 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM project_members').fetchone()[0], 0)

    def test_conflicting_ids_roles_inactive_accounts_and_admin_takeover(self):
        self.apply()
        user = self.db.execute('SELECT user_id FROM auth_accounts').fetchone()[0]
        self.write([{**self.person, 'user_id': 'wrong-user'}]); self.apply(success=False)
        self.write([{**self.person, 'username': 'another-user', 'user_id': user}]); self.apply(success=False)
        self.write([self.person])
        self.db.execute('UPDATE auth_accounts SET active=0'); self.db.commit()
        self.apply(success=False)
        self.db.execute('UPDATE auth_accounts SET active=1')
        self.db.execute("INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,'admin')", (self.project, 'legacy-admin', 'Admin'))
        self.db.commit()
        self.write([{'username': 'legacy-admin', 'user_id': 'legacy-admin', 'display_name': 'Admin'}]); self.apply(success=False)
        self.assertEqual(self.count(), 1)
        self.assertEqual(self.db.execute("SELECT role FROM project_members WHERE user_id='legacy-admin'").fetchone()[0], 'admin')

    def test_legacy_labeller_identity_shared_password_and_rollback(self):
        self.db.execute("INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,'labeller')", (self.project, 'legacy-worker', 'Legacy worker')); self.db.commit()
        self.write([{'username': 'legacy-worker', 'user_id': 'legacy-worker', 'display_name': 'Legacy worker'}])
        password = self.root / 'shared-password.txt'; password.write_text('test-only-shared-password\n'); os.chmod(password, 0o600)
        self.apply('--shared-password-file', str(password))
        self.assertEqual(json.loads(self.output.read_text())['accounts'][0]['password'], 'test-only-shared-password')
        self.assertEqual(self.db.execute('SELECT user_id FROM auth_accounts').fetchone()[0], 'legacy-worker')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM project_members').fetchone()[0], 1)
        self.assertFalse(self.db.execute('PRAGMA foreign_key_check').fetchall())
        # A conflicting later row rejects the whole batch before earlier rows write.
        self.write([{'username': 'fresh', 'display_name': 'Fresh'}, {'username': 'legacy-worker', 'display_name': 'Wrong name'}])
        self.apply(success=False)
        self.assertEqual(self.count(), 1)

    def test_missing_schema_and_ambiguous_databases_are_rejected(self):
        self.db.execute('DROP TABLE worker_profiles'); self.db.commit()
        failure = self.run_cli(success=False)
        self.assertIn('migration 0015', failure.stderr)
        self.assertEqual(self.count(), 0)
        second = self.database.parent / 'another.sqlite'
        with sqlite3.connect(second) as db:
            db.execute('CREATE TABLE projects(id TEXT)')
        failure = self.run_cli(success=False)
        self.assertIn('found 2', failure.stderr)

    def test_shared_password_and_backup_permissions_are_enforced(self):
        password = self.root / 'shared.txt'; password.write_text('private-test-password'); os.chmod(password, 0o644)
        self.apply('--shared-password-file', str(password), success=False)
        self.assertEqual(self.count(), 0)
        self.assertFalse(self.output.exists())
        backup_dir = self.state / 'labeller-backups'; os.chmod(backup_dir, 0o755)
        failure = self.apply(success=False)
        self.assertIn('Backup directory must be private', failure.stderr)
        self.assertEqual(self.count(), 0)

    def test_guided_labeller_dry_run_cancel_and_import(self):
        command = ['python3', str(REPO/'scripts/add_labeller.py'), '--state-root', str(self.state), '--project-id', self.project, '--username', 'guided-worker', '--credentials-out', str(self.output)]
        # display, legacy ID, country, profession, languages, experience
        fields = '\n'.join(['Guided worker', '', 'Thailand', 'Linguist', 'English,Thai', '4'])+'\n'
        dry = subprocess.run(command+['--dry-run'], input=fields, text=True, capture_output=True)
        self.assertEqual(dry.returncode, 0, dry.stderr);self.assertEqual(self.count(), 0);self.assertFalse(self.output.exists())
        canceled = subprocess.run(command, input=fields+'n\n', text=True, capture_output=True)
        self.assertEqual(canceled.returncode, 0, canceled.stderr);self.assertEqual(self.count(), 0)
        applied = subprocess.run(command, input=fields+'y\nSTOPPED\n', text=True, capture_output=True)
        self.assertEqual(applied.returncode, 0, applied.stderr);self.assertEqual(self.count(), 1)
        self.assertEqual(self.db.execute('SELECT profession FROM worker_profiles').fetchone()[0], 'Linguist')
        secret = json.loads(self.output.read_text())['accounts'][0]['password']
        self.assertNotIn(secret, applied.stdout+applied.stderr);self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)

    def test_manifest_scope_and_secret_guards(self):
        for change in [{'role': 'admin'}, {'password': 'do-not-store'}, {'languages': [3]}, {'experience_years': True}, {'metadata': {'bad': 7}}, {'username': 'UPPER'}, {'active': 1}]:
            self.write([{**self.person, **change}]); self.run_cli(success=False)
        self.write([self.person, self.person]); self.run_cli(success=False)
        self.manifest.write_text('{"schema_version":1,"schema_version":1,"labellers":[]}'); self.run_cli(success=False)
        self.write([self.person]); self.run_cli('--project-id', str(uuid.uuid4()), success=False)
        rejected = self.run_cli('--import', '--server-stopped', '--credentials-out', str(REPO / 'never-written-credentials.json'), success=False)
        self.assertIn('outside the repository', rejected.stderr)
        self.assertEqual(self.count(), 0)
        self.assertFalse((REPO / 'never-written-credentials.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
