#!/usr/bin/env python3
"""Capture cloudflared's human application JWT privately; never print the token.

Run cloudflared access login for the same HTTPS origin first. This is a credential
acquisition wrapper, not a token verifier; AudioLab still verifies JWT signatures,
claims, active identity links and project permissions on every API request.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    url = urlparse(args.origin)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path or url.query or url.fragment:
        raise ValueError('Use the exact canonical HTTPS origin without a path.')
    # Existing files are refused: renew into a new file and explicitly switch the
    # importer. A failed refresh must never erase a still-usable credential.
    if args.output.exists() or args.output.is_symlink():
        raise ValueError('Choose a new private output file; existing credentials are preserved.')
    result = subprocess.run(['cloudflared', 'access', 'token', '--app=' + args.origin], capture_output=True, text=True)
    token = result.stdout.strip()
    if result.returncode or len(token) > 16384 or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token):
        raise ValueError('No application token obtained. Run cloudflared access login for this origin, then retry. Provider output was withheld.')
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump({'origin': args.origin, 'token': token}, handle)
    print('Private origin-bound credential written; no token was printed.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print('ERROR: ' + str(error), file=sys.stderr)
        sys.exit(1)
