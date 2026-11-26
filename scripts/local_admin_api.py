"""Authenticated API client shared by administration CLIs.

Passwords never enter command arguments or logs. Owned login sessions are revoked
on exit; a borrowed private cookie jar is left intact. No redirect/proxy may send
credentials or source data to another host. Caller-provided IDs are assertions,
not identity: user_id and roles come from the verified /auth/session response.
"""
import getpass
import http.cookiejar
import json
import re
from pathlib import Path
import sys
from urllib.parse import urlparse
import requests


def private_file(path):
    path = Path(path).expanduser()
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('Credential/cookie files must be private regular files (chmod 600).')
    if path.stat().st_size > 65536:
        raise ValueError('Credential/cookie file exceeds 64 KiB.')
    return path


def credentials(path, username):
    """Read a private CLI JSON, one password line, or existing demo-login.txt."""
    text = private_file(path).read_text(encoding='utf-8')
    if text.lstrip().startswith('{'):
        data = json.loads(text)
        if not isinstance(data, dict) or not isinstance(data.get('accounts'), list):
            raise ValueError('Expected CLI credentials JSON with an accounts list.')
        accounts = data['accounts']
        matches = [row for row in accounts if isinstance(row, dict) and (not username or row.get('username') == username)]
        if len(matches) != 1:
            raise ValueError('Choose one username present in the credentials JSON.')
        username, password = matches[0].get('username'), matches[0].get('password')
    else:
        lines = text.splitlines()
        if len(lines) == 1:
            password = lines[0]
        elif Path(path).name == 'demo-login.txt' and lines and lines[0].startswith('Local demo only.'):
            password = lines[-1]
        else:
            raise ValueError('Expected CLI credentials JSON, one password line, or the existing demo-login.txt format.')
    if not isinstance(username, str) or not username or not isinstance(password, str) or not 8 <= len(password) <= 256:
        raise ValueError('A username and valid password are required; no secret was printed.')
    return username, password


class LocalAdminAPI:
    """Verify session before data access; HTTPS Access tokens are borrowed.

    The historical name remains for local callers. An Access credential envelope
    pins its exact origin independently of the CLI target, preventing accidental
    token/corpus forwarding to another host. TLS verification stays enabled.
    """
    def __init__(self, base_url, username=None, credentials_file=None, cookie_file=None, *, auth='local', access_token_file=None):
        parsed = urlparse(base_url)
        if parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment or not parsed.hostname:
            raise ValueError('Use an exact application origin without credentials, path or query.')
        if auth not in ('local', 'access'):
            raise ValueError('Choose local or access authentication explicitly.')
        if auth == 'local' and (parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1')):
            raise ValueError('Local authentication supports only a controlled loopback HTTP origin.')
        if auth == 'access' and (parsed.scheme != 'https' or not access_token_file or credentials_file or cookie_file or username):
            raise ValueError('Access authentication requires HTTPS and --access-token-file, without local credentials/cookies.')
        if auth == 'local' and access_token_file:
            raise ValueError('--access-token-file requires explicit --auth access.')
        if credentials_file and cookie_file:
            raise ValueError('Choose credentials or a cookie file, not both.')
        self.base = base_url.rstrip('/')
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.headers['Origin'] = self.base
        self.owned = False
        try:
            if auth == 'access':
                data = json.loads(private_file(access_token_file).read_text(encoding='utf-8'))
                token = data.get('token') if isinstance(data, dict) else None
                if not isinstance(data, dict) or data.get('origin') != self.base or not isinstance(token, str) or not 1 <= len(token) <= 16384 or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token):
                    raise ValueError('Access token envelope must contain this exact origin and one application JWT.')
                # Access edge accepts the application token cookie; the origin
                # receives/verifies its signed assertion. Never log this header.
                self.session.headers['Cookie'] = 'CF_Authorization=' + token
            elif cookie_file:
                jar = http.cookiejar.MozillaCookieJar(str(private_file(cookie_file)))
                jar.load(ignore_discard=True)
                self.session.cookies.update(jar)
            else:
                if credentials_file:
                    username, password = credentials(credentials_file, username)
                else:
                    if not sys.stdin.isatty():
                        raise ValueError('Use --username with --credentials-file for noninteractive login, or run in a terminal for a hidden password prompt.')
                    username = username or input('Admin username: ').strip()
                    password = getpass.getpass('Admin password (hidden): ')
                response = self.request('POST', '/api/v1/auth/login', json={'username': username, 'password': password})
                if response.status_code != 200:
                    raise ValueError(f'Login failed (HTTP {response.status_code}); check credentials/auth mode.')
                self.owned = True
            response = self.request('GET', '/api/v1/auth/session')
            if response.status_code != 200:
                raise ValueError(f'Session unavailable (HTTP {response.status_code}); sign in again.')
            payload = response.json()
            self.user_id = (payload.get('user') or {}).get('userId')
            self.memberships = payload.get('memberships', [])
            if not self.user_id:
                raise ValueError('No verified login. Reauthenticate if expired; ask an operator to verify the identity link and active account.')
            if auth == 'access' and payload['user'].get('mode') != 'access':
                raise ValueError('Endpoint did not verify an Access identity; no data requests allowed.')
        except Exception:
            self.close()
            raise

    def request(self, method, path, **kwargs):
        if not path.startswith('/api/v1/') or path.startswith('//'):
            raise ValueError('Only relative AudioLab API paths are allowed.')
        if any(key in kwargs for key in ('verify', 'allow_redirects', 'timeout', 'proxies', 'auth', 'cookies')):
            raise ValueError('Transport security and credentials cannot be overridden per request.')
        if any(key.lower() in ('origin','cookie','authorization','cf-access-jwt-assertion','host') for key in kwargs.get('headers',{})):
            raise ValueError('Authentication/origin headers cannot be overridden per request.')
        if 'json' in kwargs:
            # Keep the canonical importer's UTF-8 payload sizing invariant.
            kwargs['data'] = json.dumps(kwargs.pop('json'), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            kwargs['headers'] = {**kwargs.get('headers', {}), 'Content-Type': 'application/json'}
        response = self.session.request(method, self.base + path, timeout=120, allow_redirects=False, **kwargs)
        if 300 <= response.status_code < 400:
            raise ValueError('API redirect denied; verify canonical origin and renew expired Access credentials. No redirect was followed.')
        if response.status_code in (401,403) and self.base.startswith('https://'):
            raise ValueError(f'Access/API authentication or authorization denied (HTTP {response.status_code}); renew the application token and verify account/project permission.')
        return response

    def require_admin(self, project_id, asserted_user=None):
        if asserted_user and asserted_user != self.user_id:
            raise ValueError('--user-id does not match the authenticated account.')
        if not any(member.get('projectId') == str(project_id) and member.get('role') == 'admin' for member in self.memberships):
            raise ValueError('The authenticated account is not an admin of the selected project.')

    def close(self):
        if self.owned:
            try:
                self.request('POST', '/api/v1/auth/logout')
            except (requests.RequestException, ValueError):
                pass  # Cleanup failure must not obscure the original import error.
            self.owned = False
        self.session.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
