#!/usr/bin/env python3
"""Create a disposable local D1/R2 copy; never reset or write the source state."""
import json
import pathlib
import shutil
import sqlite3
import tempfile


def main():
    repo = pathlib.Path(__file__).resolve().parents[1]
    source = repo / '.cloudflare/state/v3'
    if not source.is_dir():
        raise SystemExit('No existing local state. Apply the repository migrations to a separately provisioned disposable state first.')
    destination = pathlib.Path(tempfile.mkdtemp(prefix='audiolab-assignment-demo-'))
    # Online SQLite backup includes committed WAL data while the normal server
    # runs. Ordinary file copying of an active SQLite/WAL pair is unsafe.
    for original in (source / 'd1').rglob('*.sqlite'):
        target = destination / 'v3/d1' / original.relative_to(source / 'd1')
        target.parent.mkdir(parents=True, exist_ok=True)
        reader = sqlite3.connect(original.resolve().as_uri() + '?mode=ro', uri=True)
        writer = sqlite3.connect(target)
        reader.backup(writer)
        writer.close()
        reader.close()
    if (source / 'r2').exists():
        shutil.copytree(source / 'r2', destination / 'v3/r2')
    (destination / 'DISPOSABLE_DEMO.json').write_text(json.dumps({'source': str(source), 'purpose': 'Assignment MVP local test copy'}))
    print(destination)


if __name__ == '__main__':
    main()
