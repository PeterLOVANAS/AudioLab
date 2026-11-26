#!/usr/bin/env python3
"""Guided local labeller creation; reuses the strict backed-up provisioning CLI.

One person at a time. Bulk JSON imports remain available in import_labellers.py.
No public registration, remote D1, password reset or migration is introduced.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_labellers as importer


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-root', help='Defaults to AUDIOLAB_LOCAL_STATE, otherwise prompts')
    parser.add_argument('--project-id', action='append', default=[], help='Existing project UUID; otherwise choose from a numbered list')
    parser.add_argument('--username', help='Otherwise prompted')
    parser.add_argument('--credentials-out', help='New private file outside Git; otherwise a private home directory is suggested')
    parser.add_argument('--dry-run', action='store_true', help='Show the plan and stop without provisioning')
    parser.add_argument('--update-profiles', action='store_true', help='Explicit profile changes only; never resets passwords or roles')
    args = parser.parse_args(argv)
    try:
        default = os.environ.get('AUDIOLAB_LOCAL_STATE', str(importer.REPO / '.cloudflare/state'))
        root = Path(args.state_root or input(f'Local state root [{default}]: ').strip() or default).expanduser().resolve()
        database = importer.find_database(root)
        with importer.connect(database) as db:
            projects = [dict(row) for row in db.execute('SELECT id,name FROM projects ORDER BY name,id')]
            selected = args.project_id
            if not selected:
                if not projects:
                    raise ValueError('Create a project first in Project configuration.')
                for index, project in enumerate(projects, 1):
                    print(f"{index}. {project['name']} ({project['id']})")
                numbers = input('Target project numbers (comma-separated): ').strip().split(',')
                if any(not value.strip().isdigit() or not 1 <= int(value.strip()) <= len(projects) for value in numbers):
                    raise ValueError('Invalid project selection.')
                selected = list(dict.fromkeys(projects[int(value.strip()) - 1]['id'] for value in numbers))
            username = args.username or input('Labeller login username: ').strip()
            existing = db.execute('SELECT display_name FROM auth_accounts WHERE username=?', (username,)).fetchone()
        display = input(f"Display name [{existing['display_name'] if existing else username}]: ").strip() or (existing['display_name'] if existing else username)
        person = {'username': username, 'display_name': display}
        for key, label in [('user_id', 'Existing legacy user ID (blank for new/reuse account)'), ('country', 'Country'), ('profession', 'Profession (e.g. Linguist)'), ('languages', 'Languages (comma-separated, e.g. English,Thai)'), ('experience_years', 'Experience years')]:
            value = input(label + ' [leave blank to keep/default]: ').strip()
            if value:
                person[key] = [entry.strip() for entry in value.split(',')] if key == 'languages' else int(value) if key == 'experience_years' else value
        rows = importer.validate({'schema_version': 1, 'labellers': [person]})
        with importer.connect(database) as db:
            plan = importer.plan(db, rows, selected, args.update_profiles)
        summary = importer.report(plan, database, 'dry-run')
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if args.dry_run or not any(summary['counts'].values()):
            return 0
        if input('Apply this local account/membership/profile plan? [y/N]: ').strip().lower() != 'y':
            print('Canceled. No account/profile/assignment changes.'); return 0
        if input('Stop every server using this state root, then type STOPPED: ').strip() != 'STOPPED':
            print('Canceled. No account/profile/assignment changes.'); return 0
        output = args.credentials_out
        if summary['counts']['new_accounts'] and not output:
            default_dir = Path.home() / '.audiolab' / 'credentials'
            default_name = 'labellers-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(4) + '.json'
            output = input(f'NEW private credentials file [{default_dir / default_name}]: ').strip() or str(default_dir / default_name)
        if output:
            # Create only the chosen output directory, after review/STOPPED.
            path = Path(output).expanduser()
            if importer.REPO == path.resolve() or importer.REPO in path.resolve().parents:
                raise ValueError('Credentials must be outside the repository.')
            path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='audiolab-labeller-plan-') as directory:
            manifest = Path(directory) / 'labellers.json'
            manifest.write_text(json.dumps({'schema_version': 1, 'labellers': [person]}, ensure_ascii=False), encoding='utf-8')
            command = ['--state-root', str(root), '--manifest', str(manifest), '--import', '--server-stopped']
            for project in selected:
                command.extend(['--project-id', project])
            if output:
                command.extend(['--credentials-out', output])
            if args.update_profiles:
                command.append('--update-profiles')
            return importer.main(command)
    except KeyboardInterrupt:
        print('Canceled. Inspect the last provisioning report before retrying.',file=sys.stderr)
        return 130
    except (ValueError, OSError, importer.sqlite3.Error, EOFError) as error:
        print('Labeller setup failed: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
