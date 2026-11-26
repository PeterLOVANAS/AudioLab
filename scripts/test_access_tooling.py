"""Offline provisioning/credential boundaries on disposable SQLite and files."""
import copy
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from unittest.mock import patch
from types import SimpleNamespace
from provision_access import build_batch
import access_token


class AccessToolingTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        for migration in sorted((Path(__file__).resolve().parents[1]/'migrations').glob('*.sql')):
            self.db.executescript(migration.read_text())
        self.user, self.project = str(uuid.uuid4()), str(uuid.uuid4())
        self.manifest = {'issuer':'https://test.cloudflareaccess.com','bootstrap':True,
            'project':{'id':self.project,'name':'Synthetic','slug':'synthetic'},
            'accounts':[{'mode':'create','userId':self.user,'username':'admin','displayName':'Admin','subject':'verified-subject'}],
            'memberships':[{'projectId':self.project,'userId':self.user,'role':'admin'}]}

    def tearDown(self): self.db.close()

    def apply(self, manifest):
        with self.db:
            for row in build_batch(manifest): self.db.execute(row['sql'],row['params'])

    def test_bootstrap_replay_conflict_and_no_password(self):
        self.apply(self.manifest);self.apply(self.manifest)
        self.assertEqual(self.db.execute('SELECT count(*),demo_salt,demo_password_hash FROM auth_accounts').fetchone(),(1,None,None))
        changed=copy.deepcopy(self.manifest);changed['accounts'][0]['subject']='new-subject'
        changed['accounts'][0]['username']='different'
        with self.assertRaises(sqlite3.Error):self.apply(changed)
        self.assertEqual(self.db.execute('SELECT count(*) FROM auth_identity_links').fetchone()[0],1)

    def test_late_membership_conflict_rolls_back_account_and_link(self):
        self.apply(self.manifest)
        other=str(uuid.uuid4())
        value={'issuer':self.manifest['issuer'],'accounts':[{'mode':'create','userId':other,'username':'new-person','displayName':'New','subject':'new-sub'}],
          'memberships':[{'projectId':self.project,'userId':other,'role':'labeller'},{'projectId':str(uuid.uuid4()),'userId':other,'role':'admin'}]}
        with self.assertRaises(sqlite3.Error):self.apply(value)
        self.assertIsNone(self.db.execute('SELECT 1 FROM auth_accounts WHERE user_id=?',(other,)).fetchone())
        self.assertEqual(self.db.execute('SELECT count(*) FROM auth_identity_links').fetchone()[0],1)

    def test_no_legacy_adoption_identity_steal_or_role_promotion(self):
        self.apply(self.manifest)
        for change in ['legacy','subject','role']:
            other=str(uuid.uuid4())
            value={'issuer':self.manifest['issuer'],'accounts':[{'mode':'create','userId':other,'username':'new-person','displayName':'New','subject':'new-sub'}],
              'memberships':[{'projectId':self.project,'userId':other,'role':'admin'}]}
            if change=='legacy':
                self.db.execute('INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,?)',(self.project,other,'Legacy','labeller'));self.db.commit()
            elif change=='subject':value['accounts'][0]['subject']='verified-subject'
            else:
                value={'issuer':self.manifest['issuer'],'accounts':[{**self.manifest['accounts'][0],'mode':'link'}],
                  'memberships':[{'projectId':self.project,'userId':self.user,'role':'labeller'}]}
            with self.assertRaises(sqlite3.Error):self.apply(value)
        self.assertEqual(self.db.execute('SELECT role FROM project_members WHERE user_id=?',(self.user,)).fetchone()[0],'admin')

    def test_private_token_capture_and_failed_renewal_preserves_file(self):
        with tempfile.TemporaryDirectory() as root:
            output=Path(root)/'token.json'
            argv=['access_token.py','--origin','https://audio.example','--output',str(output)]
            with patch('sys.argv',argv),patch('access_token.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout='test.payload.signature\n')):
                access_token.main()
            self.assertEqual(output.stat().st_mode&0o777,0o600)
            self.assertEqual(json.loads(output.read_text())['origin'],'https://audio.example')
            before=output.read_bytes()
            with patch('sys.argv',argv),self.assertRaises(ValueError):access_token.main()
            self.assertEqual(output.read_bytes(),before)
            for origin in ['http://audio.example','https://user:password@audio.example','https://audio.example/path']:
                with patch('sys.argv',['capture','--origin',origin,'--output',str(Path(root)/'other')]),self.assertRaises(ValueError):access_token.main()

    def test_invalid_operator_input(self):
        for key,value in [('issuer','https://evil.example'),('accounts',[]),('unknown',True)]:
            bad={**self.manifest,key:value}
            with self.assertRaises(ValueError):build_batch(bad)


if __name__=='__main__':unittest.main(verbosity=2)
