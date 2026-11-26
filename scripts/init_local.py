#!/usr/bin/env python3
"""Initialize a NEW local AudioLab environment; existing research stores are refused.

Default prints a plan. --initialize requires an explicit new state root outside
this repository. --resume only resumes a directory created by this tool; it never
resets an account/password or promotes an existing member. All cf calls are local.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys
import uuid
from import_labellers import find_database

REPO = Path(__file__).resolve().parents[1]
MARKER = 'environment.json'


def private_json(path, value):
    """Atomically replace a private journal; never expose credentials via stdout."""
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
    os.replace(temporary, path)


def local_database_id():
    """Read the current literal DB binding; fail rather than guess another target.

    This deliberately accepts only the repository's current literal cf/config
    shape. A future dynamic binding requires an intentional update, not a fallback
    to an example UUID or a remote default.
    """
    config = (REPO / 'cloudflare.config.ts').read_text()
    match = re.search(r'\bDB\s*:\s*bindings\.d1\(\{(?P<body>.*?)\}\)', config, re.S)
    identifier = re.search(r'\bid\s*:\s*["\']([^"\']+)["\']', match['body']) if match else None
    if not identifier:
        raise ValueError('Expected one literal DB binding in cloudflare.config.ts; no database ID was guessed.')
    return str(uuid.UUID(identifier[1]))


def provision(root, environment):
    """Create first account+project+admin membership in one transaction.

    Schema already exists in this newly managed directory. No existing identity,
    membership or research project can be adopted. A matching already committed
    bootstrap is read/verified on resume; its password is never replaced.
    """
    database = find_database(root)
    credential = root / 'admin-credentials.json'
    if credential.is_symlink():
        raise ValueError('Credential output cannot be a symlink.')
    with sqlite3.connect(database) as db:
        db.execute('PRAGMA foreign_keys=ON')
        accounts = db.execute('SELECT user_id,username,demo_salt,demo_password_hash FROM auth_accounts').fetchall()
        projects = db.execute('SELECT id FROM projects').fetchall()
        if accounts or projects:
            if len(accounts) != 1 or projects != [(environment['projectId'],)] or not credential.is_file():
                raise ValueError('Bootstrap refuses existing accounts/projects; no promotion or password reset.')
            if credential.stat().st_mode & 0o077:
                raise ValueError('Bootstrap credentials must remain private (chmod 600).')
            saved = json.loads(credential.read_text())['accounts'][0]
            account = accounts[0]
            membership = db.execute('SELECT role FROM project_members WHERE project_id=? AND user_id=?',
                                    (environment['projectId'], environment['userId'])).fetchone()
            digest = hashlib.pbkdf2_hmac('sha256', saved['password'].encode(), account[2].encode(), 100000).hex()
            if account[:2] != (environment['userId'], environment['username']) or membership != ('admin',) or digest != account[3]:
                raise ValueError('Bootstrap identity does not match journal; refusing account changes.')
            return
        if credential.exists():
            if credential.stat().st_mode & 0o077:
                raise ValueError('Credential file is not private.')
            saved = json.loads(credential.read_text())['accounts'][0]
            if saved['user_id'] != environment['userId'] or saved['username'] != environment['username']:
                raise ValueError('Credential identity differs from bootstrap journal.')
            password = saved['password']
        else:
            password = secrets.token_urlsafe(32)
            private_json(credential, {'accounts': [{'user_id': environment['userId'],
                         'username': environment['username'], 'password': password}]})
        salt = secrets.token_hex(16)
        digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000).hex()
        db.execute('BEGIN IMMEDIATE')
        db.execute('INSERT INTO projects(id,name,slug) VALUES(?,?,?)',
                   (environment['projectId'], environment['projectName'], environment['projectSlug']))
        db.execute('INSERT INTO auth_accounts(user_id,username,display_name,demo_salt,demo_password_hash) VALUES(?,?,?,?,?)',
                   (environment['userId'], environment['username'], environment['displayName'], salt, digest))
        db.execute('INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,?)',
                   (environment['projectId'], environment['userId'], environment['displayName'], 'admin'))
        if db.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('Bootstrap foreign-key check failed.')


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--state-root', type=Path, required=True)
    p.add_argument('--username', default='local-admin')
    p.add_argument('--display-name', default='Local administrator')
    p.add_argument('--project-name', default='Listening study')
    p.add_argument('--project-slug', default='listening-study')
    p.add_argument('--initialize', action='store_true', help='Create state, apply existing local migrations, provision first admin')
    p.add_argument('--resume', action='store_true', help='Resume only a failed/ready bootstrap created by this tool')
    p.add_argument('--server-stopped', action='store_true', help='Assert no server uses this state while initializing/resuming')
    args = p.parse_args(argv)
    root = args.state_root.expanduser().resolve()
    if root == REPO or REPO in root.parents or root == Path(root.anchor) or args.state_root.is_symlink():
        raise ValueError('Choose a new state root outside the repository, never preserved .cloudflare/state.')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,63}', args.username):
        raise ValueError('Username needs 1–64 lowercase letters/numbers/dots/underscores/hyphens.')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', args.project_slug) or len(args.project_slug) > 80:
        raise ValueError('Use a project slug of at most 80 lowercase letters/numbers/hyphens.')
    for value in [args.project_name, args.display_name]:
        if not value.strip() or len(value) > 120 or any(ord(c) < 32 for c in value):
            raise ValueError('Names must contain 1–120 printable characters.')
    database_id = local_database_id()
    if not args.initialize:
        print(json.dumps({'mode': 'plan', 'stateRoot': str(root), 'databaseBinding': 'DB',
                          'databaseId': database_id, 'remote': False, 'steps': ['apply existing migrations locally', 'provision first local admin and project'],
                          'note': 'No writes. Use --initialize --server-stopped; directory must be new.'}, indent=2))
        return
    if not args.server_stopped:
        raise ValueError('Initialization requires --server-stopped for this explicit state root.')
    marker = root / MARKER
    if args.resume:
        if not marker.is_file() or marker.is_symlink() or root.stat().st_mode & 0o077:
            raise ValueError('Resume requires a private state root and the original bootstrap journal.')
        environment = json.loads(marker.read_text())
        if environment.get('kind') != 'audiolab.local-environment/1' or environment.get('stateRoot') != str(root) or environment.get('databaseId') != database_id:
            raise ValueError('Journal/config/state mismatch. No existing store may be adopted.')
        if environment['status'] == 'ready':
            # Ready environments are never reprovisioned after research use.
            print(json.dumps({'mode': 'ready', 'stateRoot': str(root), 'projectId': environment['projectId'], 'note': 'Already initialized; no changes.'}, indent=2))
            return
    else:
        if root.exists():
            raise ValueError('State root already exists. Choose a new directory; no existing files will be reset.')
        root.mkdir(mode=0o700, parents=True)
        environment = {'kind': 'audiolab.local-environment/1', 'stateRoot': str(root), 'databaseId': database_id,
                       'projectId': str(uuid.uuid4()), 'userId': str(uuid.uuid4()), 'username': args.username,
                       'displayName': args.display_name.strip(), 'projectName': args.project_name.strip(),
                       'projectSlug': args.project_slug, 'status': 'starting'}
        private_json(marker, environment)
    try:
        environment['status'] = 'migrating'; private_json(marker, environment)
        command = [str(REPO / 'node_modules/.bin/cf'), 'd1', 'migrations', 'apply', database_id,
                   '--local', '--persist-to', str(root), '--dir', str(REPO / 'migrations')]
        subprocess.run(command, check=True, cwd=REPO)
        environment['status'] = 'provisioning'; private_json(marker, environment)
        provision(root, environment)
        environment['status'] = 'ready'; private_json(marker, environment)
    except BaseException:
        # Journal retains the last attempted phase. Do not delete a failed store.
        print('Initialization incomplete; retain the state/journal, stop its server and use --resume. No existing research store was targeted.', file=sys.stderr)
        raise
    print(json.dumps({'mode': 'ready', 'stateRoot': str(root), 'projectId': environment['projectId'],
                      'username': environment['username'], 'credentialsFile': str(root / 'admin-credentials.json'),
                      'note': 'Local DEV identity only; production Access linking is separate. Never publish this directory.'}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, sqlite3.Error, subprocess.CalledProcessError) as error:
        print('ERROR: ' + str(error), file=sys.stderr)
        sys.exit(1)
