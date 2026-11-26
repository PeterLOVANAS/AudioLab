#!/usr/bin/env python3
"""Provision local AudioLab labellers from strict JSON; default is read-only dry-run.

Offline administration only: no remote D1, HTTP endpoints, migrations, account
resets or role changes. Stop the server before --import. Credentials are issued
only for NEW accounts; existing user IDs and annotation history are preserved.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import uuid

REPO = Path(__file__).resolve().parents[1]
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, 'audiolab:local-labellers:v1')
PROFILE_DEFAULTS = {'country': '', 'profession': '', 'languages': [], 'experience_years': 0, 'metadata': {}, 'active': True}


def strict_json(path):
    """Reject duplicate keys and nonfinite numbers rather than changing intent."""
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise ValueError('Duplicate JSON key: ' + key)
            result[key] = value
        return result
    def nonfinite(_):
        raise ValueError('Nonfinite JSON numbers are not supported.')
    if path.stat().st_size > 512 * 1024:
        raise ValueError('Manifest exceeds 512 KiB.')
    return json.loads(path.read_text(encoding='utf-8-sig'), object_pairs_hook=pairs, parse_constant=nonfinite)


def text(value, label, maximum, empty=False):
    if not isinstance(value, str) or value != value.strip() or (not value and not empty) or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise ValueError(f'{label}: expected trimmed text, {0 if empty else 1}–{maximum} characters, without control characters.')
    return value


def validate(payload):
    """Validate a bounded, labeller-only manifest, returning explicit profile patches."""
    if not isinstance(payload, dict) or set(payload) != {'schema_version', 'labellers'} or type(payload['schema_version']) is not int or payload['schema_version'] != 1:
        raise ValueError('Manifest requires only schema_version: 1 and labellers: [...].')
    rows = payload['labellers']
    if not isinstance(rows, list) or not 1 <= len(rows) <= 200:
        raise ValueError('labellers: expected 1–200 entries.')
    users, identities, result = set(), set(), []
    allowed = {'username', 'user_id', 'display_name', *PROFILE_DEFAULTS}
    for index, row in enumerate(rows):
        where = f'labellers[{index}]'
        if not isinstance(row, dict) or set(row) - allowed:
            raise ValueError(f'{where}: unknown fields; passwords and roles do not belong in the manifest.')
        username = text(row.get('username'), where + '.username', 64)
        if not re.fullmatch(r'[a-z0-9][a-z0-9_.-]*', username):
            raise ValueError(where + '.username: use lowercase letters, numbers, dots, underscores or hyphens.')
        display = text(row.get('display_name'), where + '.display_name', 120)
        user_id = text(row['user_id'], where + '.user_id', 128) if 'user_id' in row else None
        if username in users or (user_id is not None and user_id in identities):
            raise ValueError(where + ': duplicate username or user_id.')
        users.add(username)
        if user_id:
            identities.add(user_id)
        profile = {key: row[key] for key in PROFILE_DEFAULTS if key in row}
        for key, maximum in [('country', 80), ('profession', 120)]:
            if key in profile:
                text(profile[key], where + '.' + key, maximum, empty=True)
        if 'languages' in profile:
            languages = profile['languages']
            if not isinstance(languages, list) or len(languages) > 20:
                raise ValueError(where + '.languages: expected up to 20 language names.')
            for language in languages:
                text(language, where + '.languages', 60)
            if len(set(languages)) != len(languages):
                raise ValueError(where + '.languages: duplicates are not allowed.')
        if 'experience_years' in profile and (type(profile['experience_years']) is not int or not 0 <= profile['experience_years'] <= 100):
            raise ValueError(where + '.experience_years: expected integer 0–100.')
        if 'active' in profile and type(profile['active']) is not bool:
            raise ValueError(where + '.active: expected Boolean.')
        if 'metadata' in profile:
            metadata = profile['metadata']
            if not isinstance(metadata, dict) or len(metadata) > 20:
                raise ValueError(where + '.metadata: expected up to 20 text properties.')
            for key, value in metadata.items():
                text(key, where + '.metadata key', 60)
                text(value, where + '.metadata value', 200, empty=True)
        result.append({'username': username, 'user_id': user_id, 'display_name': display, 'profile': profile})
    return result


def connect(path, mode='ro'):
    db = sqlite3.connect(path.as_uri() + '?mode=' + mode, uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def find_database(root):
    """Find exactly one real local D1 store, ignoring Miniflare metadata databases."""
    candidates = []
    for candidate in (root / 'v3/d1').rglob('*.sqlite'):
        if candidate.name == 'metadata.sqlite':
            continue
        path = candidate.resolve()
        if root not in path.parents:
            raise ValueError('D1 symlink escapes the explicit state root.')
        with connect(path) as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").fetchone():
                candidates.append(path)
    if len(candidates) != 1:
        raise ValueError('Expected exactly one AudioLab D1 under --state-root/v3/d1; found ' + str(len(candidates)) + '.')
    with connect(candidates[0]) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'auth_accounts', 'project_members', 'worker_profiles'} <= tables:
            raise ValueError('Identity/profile schema missing. Review migration 0015 separately; this importer never runs migrations.')
    return candidates[0]


def plan(db, rows, projects, update_profiles):
    """Check identities and scope before any write; repeat under the write lock.

    Username reuse never resets credentials or takes over a different stable ID.
    Explicit user_id can link an existing labeller's history, but cannot create
    login credentials for a legacy admin membership. No role is ever changed.
    """
    for project in projects:
        if not db.execute('SELECT 1 FROM projects WHERE id=?', (project,)).fetchone():
            raise ValueError('Project does not exist: ' + project)
    entries, seen = [], set()
    for row in rows:
        account = db.execute('SELECT * FROM auth_accounts WHERE username=?', (row['username'],)).fetchone()
        user = row['user_id'] or (account['user_id'] if account else str(uuid.uuid5(NAMESPACE, row['username'])))
        by_id = db.execute('SELECT * FROM auth_accounts WHERE user_id=?', (user,)).fetchone()
        if user in seen or (account and account['user_id'] != user) or (by_id and by_id['username'] != row['username']):
            raise ValueError(row['username'] + ': username/user_id conflicts with another identity.')
        seen.add(user)
        if account and (not account['active'] or account['display_name'] != row['display_name'] or not account['demo_password_hash']):
            raise ValueError(row['username'] + ': existing account is inactive, has a different name, or lacks demo credentials; no account reset is performed.')
        if not account and db.execute("SELECT 1 FROM project_members WHERE user_id=? AND role='admin'", (user,)).fetchone():
            raise ValueError(row['username'] + ': refusing to issue labeller credentials for an existing admin identity.')
        memberships = []
        for project in projects:
            member = db.execute('SELECT * FROM project_members WHERE project_id=? AND user_id=?', (project, user)).fetchone()
            if member and (member['role'] != 'labeller' or member['display_name'] != row['display_name']):
                raise ValueError(row['username'] + ': conflicting membership role/name in project ' + project)
            current = db.execute('SELECT * FROM worker_profiles WHERE project_id=? AND user_id=?', (project, user)).fetchone()
            prior = dict(PROFILE_DEFAULTS) if not current else {
                'country': current['country'], 'profession': current['profession'], 'languages': json.loads(current['languages_json']),
                'experience_years': current['experience_years'], 'metadata': json.loads(current['metadata_json']), 'active': bool(current['active'])}
            desired = {**prior, **row['profile']}
            changed = bool(current and desired != prior)
            if changed and not update_profiles:
                raise ValueError(row['username'] + ': profile conflicts; use --update-profiles to explicitly update supplied profile fields.')
            memberships.append({'project_id': project, 'new_member': not member, 'new_profile': not current, 'update_profile': changed, 'profile': desired})
        entries.append({**row, 'user_id': user, 'new_account': not account, 'memberships': memberships})
    return entries


def report(entries, path, mode):
    return {'mode': mode, 'database': str(path), 'counts': {
        'new_accounts': sum(entry['new_account'] for entry in entries),
        **{key: sum(member[flag] for entry in entries for member in entry['memberships']) for key, flag in [('new_memberships', 'new_member'), ('new_profiles', 'new_profile'), ('updated_profiles', 'update_profile')]}},
        'labellers': [{'username': entry['username'], 'user_id': entry['user_id'], 'project_ids': [member['project_id'] for member in entry['memberships']]} for entry in entries]}


def import_rows(path, root, rows, projects, args):
    """Backup, lock, revalidate and commit one bounded transaction.

    Write new credentials exclusively with mode 0600 BEFORE committing accounts,
    so a failed output write cannot strand users without passwords. Rollback
    removes only a credentials file created by this operation; backups remain.
    Existing passwords, identities, sessions, teams and annotations are untouched.
    """
    db = connect(path, 'rw')
    credentials_path, created_file, committed = None, False, False
    try:
        entries = plan(db, rows, projects, args.update_profiles)
        initial = report(entries, path, 'import')
        if not any(initial['counts'].values()):
            return initial  # Identical reimports neither back up nor create credential files.
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(4)
        backup_dir = root / 'labeller-backups'
        backup_dir.mkdir(mode=0o700, exist_ok=True)
        if backup_dir.is_symlink() or backup_dir.resolve().parent != root:
            raise ValueError('Unsafe backup directory.')
        if backup_dir.stat().st_mode & 0o077:
            raise ValueError('Backup directory must be private (chmod 700).')
        backup = backup_dir / ('before-labellers-' + stamp + '.sqlite')
        fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        with sqlite3.connect(backup) as target:
            db.backup(target)
        db.execute('BEGIN IMMEDIATE')
        entries = plan(db, rows, projects, args.update_profiles)
        credentials = []
        new_accounts = any(entry['new_account'] for entry in entries)
        shared = None
        if new_accounts:
            if not args.credentials_out:
                raise ValueError('New accounts require --credentials-out at a NEW path outside the repository.')
            credentials_path = Path(args.credentials_out).expanduser().absolute()
            if REPO == credentials_path.resolve() or REPO in credentials_path.resolve().parents:
                raise ValueError('Credentials must be written outside the repository, never committed.')
            if args.shared_password_file:
                password_file = Path(args.shared_password_file).expanduser()
                if password_file.stat().st_mode & 0o077:
                    raise ValueError('Shared password file must have private permissions (chmod 600).')
                shared = password_file.read_text(encoding='utf-8').rstrip('\r\n')
                if not 8 <= len(shared) <= 256 or '\n' in shared or '\r' in shared:
                    raise ValueError('Shared password file must contain one 8–256 character password line.')
        for entry in entries:
            user = entry['user_id']
            if entry['new_account']:
                password, salt = shared or secrets.token_urlsafe(18), secrets.token_hex(16)
                hashed = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000).hex()
                db.execute('INSERT INTO auth_accounts(user_id,username,display_name,demo_salt,demo_password_hash) VALUES(?,?,?,?,?)', (user, entry['username'], entry['display_name'], salt, hashed))
                credentials.append({'username': entry['username'], 'user_id': user, 'password': password})
            for member in entry['memberships']:
                project, profile = member['project_id'], member['profile']
                if member['new_member']:
                    db.execute("INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,'labeller')", (project, user, entry['display_name']))
                values = (profile['country'], profile['profession'], json.dumps(profile['languages'], ensure_ascii=False), profile['experience_years'], json.dumps(profile['metadata'], ensure_ascii=False, sort_keys=True), int(profile['active']))
                if member['new_profile']:
                    db.execute('INSERT INTO worker_profiles(project_id,user_id,country,profession,languages_json,experience_years,metadata_json,active) VALUES(?,?,?,?,?,?,?,?)', (project, user, *values))
                elif member['update_profile']:
                    db.execute('UPDATE worker_profiles SET country=?,profession=?,languages_json=?,experience_years=?,metadata_json=?,active=? WHERE project_id=? AND user_id=?', (*values, project, user))
        if credentials:
            fd = os.open(credentials_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            created_file = True
            with os.fdopen(fd, 'w', encoding='utf-8') as output:
                json.dump({'schema_version': 1, 'local_demo_only': True, 'accounts': credentials}, output, ensure_ascii=False, indent=2)
                output.write('\n'); output.flush(); os.fsync(output.fileno())
        db.commit()
        committed = True
        result = report(entries, path, 'import')
        result['backup'] = str(backup)
        if credentials:
            result['credentials_file'] = str(credentials_path)
        return result
    finally:
        if not committed:
            db.rollback()
            if created_file:
                credentials_path.unlink()
        db.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-root', required=True, help='Explicit local persistence root (contains v3/d1)')
    parser.add_argument('--manifest', type=Path, help='Strict JSON labeller manifest')
    parser.add_argument('--project-id', action='append', default=[], help='Existing project UUID; repeat for multiple projects')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='Default: validate/read only; do not generate passwords')
    mode.add_argument('--import', dest='apply', action='store_true')
    mode.add_argument('--list-projects', action='store_true', help='List local project names/IDs without writes')
    parser.add_argument('--server-stopped', action='store_true', help='Acknowledge all processes using this state root are stopped')
    parser.add_argument('--credentials-out', help='NEW private JSON file outside the repository; new accounts only')
    parser.add_argument('--shared-password-file', help='Optional private one-line local-demo password file; never pass a password in arguments')
    parser.add_argument('--update-profiles', action='store_true', help='Explicitly update supplied profile fields, without account/password/role changes')
    args = parser.parse_args(argv)
    try:
        root = Path(args.state_root).expanduser().resolve()
        if not root.is_dir():
            raise ValueError('--state-root must be an existing local directory, not a remote URL.')
        path = find_database(root)
        if args.list_projects:
            with connect(path) as db:
                print(json.dumps({'projects': [dict(row) for row in db.execute('SELECT id,name,slug FROM projects ORDER BY name,id')]}, ensure_ascii=False, indent=2))
            return 0
        if not args.manifest or not args.project_id:
            raise ValueError('--manifest and at least one --project-id are required.')
        projects = list(dict.fromkeys(str(uuid.UUID(project)) for project in args.project_id))
        rows = validate(strict_json(args.manifest))
        with connect(path) as db:
            entries = plan(db, rows, projects, args.update_profiles)
        if args.apply:
            if not args.server_stopped:
                raise ValueError('Stop the local server, then explicitly pass --server-stopped. This flag is operator acknowledgement, not a process detector.')
            result = import_rows(path, root, rows, projects, args)
        else:
            result = report(entries, path, 'dry-run')
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, sqlite3.Error) as error:
        print('Labeller import failed: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
