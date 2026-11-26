"""Fresh-local bootstrap and example safety tests; only disposable SQLite/state."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import init_local as setup
import generate_example_dataset as example


class LocalSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='audiolab-setup-test-')
        self.root=(Path(self.temp.name)/'state').resolve()
        self.database=self.root/'v3/d1/miniflare-D1DatabaseObject/local.sqlite'
    def tearDown(self):self.temp.cleanup()
    def migrate(self,command,**kwargs):
        self.assertIn('--local',command)
        self.assertEqual(command[command.index('--persist-to')+1],str(self.root.resolve()))
        self.assertEqual(command[0],str(setup.REPO/'node_modules/.bin/cf'))
        self.database.parent.mkdir(parents=True,exist_ok=True)
        with sqlite3.connect(self.database) as db:
            for file in sorted((setup.REPO/'migrations').glob('*.sql')):db.executescript(file.read_text())
        return subprocess.CompletedProcess(command,0)
    def run_setup(self,*extra):
        setup.main(['--state-root',str(self.root),'--initialize','--server-stopped',*extra])
    def test_plan_and_existing_store_rejection(self):
        setup.main(['--state-root',str(self.root)])
        self.assertFalse(self.root.exists())
        self.root.mkdir();sentinel=self.root/'research.txt';sentinel.write_text('precious')
        with self.assertRaisesRegex(ValueError,'already exists'):self.run_setup()
        self.assertEqual(sentinel.read_text(),'precious')
        with self.assertRaisesRegex(ValueError,'outside the repository'):
            setup.main(['--state-root',str(setup.REPO/'.cloudflare/state')])
        with self.assertRaisesRegex(ValueError,'server-stopped'):
            setup.main(['--state-root',str(self.root),'--initialize'])
    def test_bootstrap_atomic_identity_private_credentials_and_no_reset(self):
        with patch.object(setup.subprocess,'run',side_effect=self.migrate):self.run_setup()
        env=json.loads((self.root/setup.MARKER).read_text())
        credentials=self.root/'admin-credentials.json';saved=json.loads(credentials.read_text())['accounts'][0]
        self.assertEqual(env['status'],'ready');self.assertEqual(credentials.stat().st_mode&0o777,0o600)
        self.assertEqual(self.root.stat().st_mode&0o777,0o700)
        with sqlite3.connect(self.database) as db:
            account=db.execute('SELECT user_id,demo_salt,demo_password_hash FROM auth_accounts').fetchone()
            self.assertEqual(account[0],saved['user_id'])
            self.assertEqual(account[2],hashlib.pbkdf2_hmac('sha256',saved['password'].encode(),account[1].encode(),100000).hex())
            self.assertEqual(db.execute('SELECT project_id,user_id,role FROM project_members').fetchall(),[(env['projectId'],env['userId'],'admin')])
            self.assertEqual(db.execute('SELECT count(*) FROM auth_identity_links').fetchone()[0],0)
        before=hashlib.sha256(credentials.read_bytes()).hexdigest()
        with patch.object(setup.subprocess,'run',side_effect=AssertionError('Ready resume cannot migrate')):self.run_setup('--resume')
        self.assertEqual(hashlib.sha256(credentials.read_bytes()).hexdigest(),before)
    def test_interrupted_migrations_resume_only_managed_root(self):
        with patch.object(setup.subprocess,'run',side_effect=OSError('synthetic migration failure')):
            with self.assertRaises(OSError):self.run_setup()
        self.assertEqual(json.loads((self.root/setup.MARKER).read_text())['status'],'migrating')
        self.assertFalse((self.root/'admin-credentials.json').exists())
        with patch.object(setup.subprocess,'run',side_effect=self.migrate):self.run_setup('--resume')
        self.assertEqual(json.loads((self.root/setup.MARKER).read_text())['status'],'ready')
    def test_no_orphan_or_privilege_adoption_on_provision_failure(self):
        def fail_membership(command,**kwargs):
            self.migrate(command,**kwargs)
            with sqlite3.connect(self.database) as db:db.executescript("CREATE TRIGGER deny_member BEFORE INSERT ON project_members BEGIN SELECT RAISE(ABORT,'fixture'); END;")
        with patch.object(setup.subprocess,'run',side_effect=fail_membership):
            with self.assertRaises(sqlite3.Error):self.run_setup()
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM projects').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT count(*) FROM auth_accounts').fetchone()[0],0)
            db.executescript('DROP TRIGGER deny_member;')
        env=json.loads((self.root/setup.MARKER).read_text())
        # Existing identities can never be adopted/promoted, including on resume.
        with sqlite3.connect(self.database) as db:db.execute("INSERT INTO auth_accounts(user_id,username,display_name) VALUES('existing','existing','Existing')")
        with self.assertRaisesRegex(ValueError,'refuses existing'):setup.provision(self.root,env)
    def test_generated_example_matches_distributable_bytes_and_schema(self):
        target=Path(self.temp.name)/'example';manifest=example.generate(target)
        reference=setup.REPO/'examples/datasets/synthetic'
        for name in ['manifest.json','SHA256SUMS.json','audio/steady-tone.wav','audio/pulsed-tone.wav']:
            self.assertEqual((target/name).read_bytes(),(reference/name).read_bytes(),name)
        validated=subprocess.run(['node',str(setup.REPO/'scripts/validate_ingestion.cjs')],input=json.dumps(manifest),text=True,capture_output=True)
        self.assertEqual(validated.returncode,0,validated.stderr)
        with self.assertRaises(FileExistsError):example.generate(target)


if __name__=='__main__':unittest.main(verbosity=2)
