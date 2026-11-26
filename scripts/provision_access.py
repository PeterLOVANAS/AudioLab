#!/usr/bin/env python3
"""Generate a reviewable private D1 batch for explicit Access account linking.

No network calls or database writes. An authorized operator applies the reviewed
batch through cf to the explicit database. Assertions precede writes in the same
D1 batch; conflicts roll back rather than promote/relink/reset existing identities.
No public bootstrap route, passwords, email matching or second account model.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import uuid
from local_admin_api import private_file


def build_batch(manifest):
    """Return parameter-bound SQL for create/link plus exact role memberships.

    The manifest is operator-reviewed input, never an application's authentication
    assertion. Obtain subjects from verified Access records, not decoded untrusted
    JWTs. `link` requires an existing active account; `create` cannot adopt a legacy
    membership lacking an account. Replays are allowed only with matching values.
    """
    if not isinstance(manifest, dict) or set(manifest) - {'issuer','accounts','memberships','project','bootstrap'}:
        raise ValueError('Unknown provisioning envelope fields.')
    issuer = manifest.get('issuer', '')
    if not re.fullmatch(r'https://[a-z0-9-]+\.cloudflareaccess\.com', issuer):
        raise ValueError('Use the exact configured Access issuer.')
    accounts = manifest.get('accounts', [])
    members = manifest.get('memberships', [])
    if 'bootstrap' in manifest and not isinstance(manifest['bootstrap'], bool):
        raise ValueError('bootstrap must be a Boolean.')
    if 'project' in manifest and not manifest['project']:
        raise ValueError('Omit project or provide its complete id/name/slug.')
    if not isinstance(accounts, list) or not 1 <= len(accounts) <= 50 or not isinstance(members, list) or len(members) > 100:
        raise ValueError('Provision 1–50 explicit accounts and at most 100 memberships.')
    batch = []
    def query(sql, *params): batch.append({'sql': sql, 'params': list(params)})
    def assertion(condition, *params):
        # SQLite JSON evaluation is lazy: malformed JSON deliberately aborts the
        # batch only when the checked precondition fails. No persistent sentinel
        # table/migration is introduced for an offline administration operation.
        query("SELECT CASE WHEN (" + condition + ") THEN 1 ELSE json('PROVISIONING_PRECONDITION_FAILED') END", *params)
    def text(value, pattern, label):
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise ValueError('Invalid ' + label)
        return value
    by_id = {}
    subjects = set()
    for row in accounts:
        if not isinstance(row, dict) or set(row) != {'mode','userId','username','displayName','subject'}:
            raise ValueError('Accounts need mode/create-or-link, userId, username, displayName and subject.')
        user = text(row['userId'], r'[A-Za-z0-9_.-]{1,128}', 'userId')
        name = text(row['username'], r'[a-z0-9][a-z0-9_.-]{0,63}', 'username')
        display = text(row['displayName'], r'[^\x00-\x1f\x7f]{1,120}', 'displayName')
        subject = text(row['subject'], r'[A-Za-z0-9_.-]{1,256}', 'verified Access subject')
        if user in by_id or subject in subjects or row['mode'] not in ('create','link'):
            raise ValueError('Duplicate identity or unsupported account mode.')
        by_id[user] = row; subjects.add(subject)
        if row['mode'] == 'create':
            uuid.UUID(user)
            assertion('NOT EXISTS(SELECT 1 FROM project_members WHERE user_id=?) OR EXISTS(SELECT 1 FROM auth_accounts WHERE user_id=?)', user, user)
        else:
            assertion('EXISTS(SELECT 1 FROM auth_accounts WHERE user_id=? AND username=? AND active=1)', user, name)
        assertion('NOT EXISTS(SELECT 1 FROM auth_identity_links WHERE issuer=? AND subject=? AND user_id<>?)', issuer, subject, user)
    project = manifest.get('project')
    if project:
        if not isinstance(project, dict) or set(project) != {'id','name','slug'}:
            raise ValueError('New project needs id/name/slug.')
        uuid.UUID(project['id'])
        text(project['name'], r'[^\x00-\x1f\x7f]{1,128}', 'project name')
        text(project['slug'], r'[a-z0-9]+(?:-[a-z0-9]+)*', 'project slug')
        if len(project['slug']) > 80: raise ValueError('Project slug exceeds 80 characters.')
    if manifest.get('bootstrap'):
        if manifest['bootstrap'] is not True or not project or len(accounts) != 1 or accounts[0]['mode'] != 'create' or members != [{'projectId':project['id'],'userId':accounts[0]['userId'],'role':'admin'}]:
            raise ValueError('Bootstrap requires one new account, one new project and its one admin membership.')
        assertion('NOT EXISTS(SELECT 1 FROM auth_accounts WHERE user_id<>?) AND NOT EXISTS(SELECT 1 FROM projects WHERE id<>?)', accounts[0]['userId'], project['id'])
        assertion('NOT EXISTS(SELECT 1 FROM auth_identity_links WHERE issuer<>? OR subject<>? OR user_id<>?)', issuer, accounts[0]['subject'], accounts[0]['userId'])
    for row in accounts:
        if row['mode'] == 'create':
            query('INSERT INTO auth_accounts(user_id,username,display_name) VALUES(?,?,?) ON CONFLICT(user_id) DO NOTHING',row['userId'],row['username'],row['displayName'])
        assertion('EXISTS(SELECT 1 FROM auth_accounts WHERE user_id=? AND username=? AND display_name=? AND active=1)',row['userId'],row['username'],row['displayName'])
        query('INSERT INTO auth_identity_links(issuer,subject,user_id) VALUES(?,?,?) ON CONFLICT(issuer,subject) DO NOTHING',issuer,row['subject'],row['userId'])
    if project:
        query('INSERT INTO projects(id,name,slug) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING', project['id'],project['name'],project['slug'])
        assertion('EXISTS(SELECT 1 FROM projects WHERE id=? AND name=? AND slug=?)', project['id'],project['name'],project['slug'])
    identities = set()
    for row in members:
        if not isinstance(row, dict) or set(row) != {'projectId','userId','role'} or not isinstance(row['userId'], str) or row['userId'] not in by_id or row['role'] not in ('admin','labeller'):
            raise ValueError('Membership must reference a declared account and explicit admin/labeller role.')
        uuid.UUID(row['projectId'])
        key = (row['projectId'], row['userId'])
        if key in identities: raise ValueError('Duplicate membership.')
        identities.add(key)
        query('INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,?) ON CONFLICT(project_id,user_id) DO NOTHING',row['projectId'],row['userId'],by_id[row['userId']]['displayName'],row['role'])
        assertion('EXISTS(SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND role=?)',row['projectId'],row['userId'],row['role'])
    return batch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    batch = build_batch(json.loads(private_file(args.manifest).read_text()))
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle: json.dump(batch, handle, indent=2)
    print('Private parameter-bound batch generated. Review exact identities/database, then apply through cf. No database or cloud was contacted.')


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, KeyError) as error:
        print('ERROR: ' + str(error), file=sys.stderr); sys.exit(1)
