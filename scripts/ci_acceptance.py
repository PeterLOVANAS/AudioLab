#!/usr/bin/env python3
"""Run existing authenticated HTTP/Chrome acceptance on NEW disposable state.

No supplied persistence root, remote target, credentials or copied dataset. The
child server uses loopback port 5202. A busy port fails without killing its owner.
Private logs/credentials remain in the temporary root; never upload that root.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

REPO = Path(__file__).resolve().parents[1]


def main():
    """Initialize and exercise actual D1/R2, restart and verify retained finals."""
    if sys.version_info < (3, 10):
        raise RuntimeError('Python 3.10+ required; CI uses 3.11')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 5202))
    root = Path(tempfile.mkdtemp(prefix='audiolab-r02b-')).resolve()
    root.chmod(0o700)
    state = root / 'state'
    env = dict(os.environ)
    # Operator credentials/configuration never select a target for these tests.
    for key in list(env):
        if key.startswith(('CLOUDFLARE_', 'ACCESS_', 'AUDIOLAB_')) or key == 'APP_ORIGIN':
            del env[key]
    env.update(AUDIOLAB_ENV='local', AUDIOLAB_AUTH_MODE='demo', AUDIOLAB_LOCAL_STATE=str(state))
    # Browser choice controls tooling only, never application authentication.
    if os.environ.get('AUDIOLAB_BROWSER_CHANNEL'):
        env['AUDIOLAB_BROWSER_CHANNEL'] = os.environ['AUDIOLAB_BROWSER_CHANNEL']
    server = None
    log = None

    def run(script, *args):
        executable = 'node' if script.endswith('.mjs') else sys.executable
        options = [] if script.endswith('.mjs') else ['-B']
        subprocess.run([executable, *options, str(REPO / 'scripts' / script), *map(str, args)], cwd=REPO, env=env, check=True)

    def stop():
        nonlocal server, log
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=20)
            except subprocess.TimeoutExpired:
                server.kill()  # Only the exact child created by this runner.
                server.wait()
            server = None
        if log is not None:
            log.close()
            log = None

    def start(label):
        nonlocal server, log
        file = root / (label + '.log')
        fd = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        log = os.fdopen(fd, 'w')
        server = subprocess.Popen([str(REPO / 'node_modules/.bin/vite'), 'dev', '--host', '127.0.0.1', '--port', '5202', '--strictPort'], cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError('Disposable server failed; inspect its private log')
            try:
                with urlopen('http://127.0.0.1:5202/api/v1/auth/session', timeout=2) as response:
                    data = json.load(response)
                if data.get('mode') == 'demo':
                    return
            except (OSError, ValueError):
                pass
            time.sleep(0.25)
        raise RuntimeError('Disposable server did not become ready')

    try:
        run('init_local.py', '--state-root', state, '--initialize', '--server-stopped')
        start('prepare-server')
        run('test_release_http.py', '--state-root', state, '--phase', 'prepare')
        stop()
        run('test_release_http.py', '--state-root', state, '--phase', 'provision', '--server-stopped')
        start('annotation-server')
        run('test_release_http.py', '--state-root', state, '--phase', 'exercise')
        run('test_fresh_ingestion_http.py', '--state-root', state, '--base-url', 'http://127.0.0.1:5202')
        stop()
        run('test_release_http.py', '--state-root', state, '--phase', 'legacy-seed', '--server-stopped')
        start('legacy-browser-server')
        run('test_release_http.py', '--state-root', state, '--phase', 'legacy-exercise')
        run('test_release_browser.mjs', state)
        stop()
        start('restart-server')
        run('test_release_http.py', '--state-root', state, '--phase', 'verify')
        print('PASS fresh HTTP/browser/restart acceptance. Private evidence:', root)
    finally:
        stop()
        print('Disposable state retained privately; not a CI upload artifact:', root)


if __name__ == '__main__':
    main()
