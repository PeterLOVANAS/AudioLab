"""Focused auth boundary tests without sockets or database writes."""
import http.cookiejar
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import requests
from local_admin_api import LocalAdminAPI


class Response:
    def __init__(self, status=200, payload=None):
        self.status_code, self.payload = status, payload or {}
    def json(self):
        return self.payload


class Session:
    def __init__(self, role='admin', redirect=False, user='actual-user', login_status=200):
        self.headers, self.cookies, self.calls, self.trust_env = {}, requests.cookies.RequestsCookieJar(), [], True
        self.role, self.redirect, self.user = role, redirect, user
        self.login_status = login_status
    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if url.endswith('/auth/login'):
            return Response(302 if self.redirect else self.login_status)
        if url.endswith('/auth/session'):
            return Response(payload={'user': {'userId': self.user}, 'memberships': [{'projectId': 'project', 'role': self.role}]})
        return Response()
    def close(self):
        pass


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'password.txt'
        self.path.write_text('secret-test-only-password\n'); os.chmod(self.path, 0o600)
    def tearDown(self):
        self.temp.cleanup()
    def test_identity_origin_utf8_and_owned_logout(self):
        session = Session()
        with patch('local_admin_api.requests.Session', return_value=session):
            with LocalAdminAPI('http://127.0.0.1:5175', 'admin', self.path) as client:
                self.assertEqual(client.user_id, 'actual-user'); client.require_admin('project')
                self.assertFalse(session.trust_env)
                self.assertEqual(session.headers['Origin'], 'http://127.0.0.1:5175')
                client.request('POST', '/api/v1/dataset-ingestion/validate', json={'text': 'สวัสดี'})
                self.assertIn('สวัสดี'.encode(), session.calls[-1][2]['data'])
                for _, _, kwargs in session.calls:
                    self.assertFalse(kwargs['allow_redirects'])
                with self.assertRaisesRegex(ValueError, 'does not match'):client.require_admin('project', 'spoof-user')
                with self.assertRaisesRegex(ValueError, 'not an admin'):client.require_admin('other')
            self.assertTrue(session.calls[-1][1].endswith('/auth/logout'))
    def test_remote_redirect_and_permissions(self):
        with self.assertRaises(ValueError):LocalAdminAPI('https://example.com', 'admin', self.path)
        with self.assertRaises(ValueError):LocalAdminAPI('http://localhost:5175/path', 'admin', self.path)
        session = Session(redirect=True)
        with patch('local_admin_api.requests.Session', return_value=session):
            with self.assertRaisesRegex(ValueError, 'redirect'):LocalAdminAPI('http://localhost:5175', 'admin', self.path)
            self.assertEqual(len(session.calls), 1)
        os.chmod(self.path, 0o644)
        with self.assertRaisesRegex(ValueError, 'private'):LocalAdminAPI('http://localhost:5175', 'admin', self.path)
    def test_borrowed_cookie_and_labeller_role(self):
        cookie = Path(self.temp.name) / 'cookies.txt'
        jar = http.cookiejar.MozillaCookieJar(str(cookie)); jar.save(); os.chmod(cookie, 0o600)
        session = Session(role='labeller')
        with patch('local_admin_api.requests.Session', return_value=session):
            with LocalAdminAPI('http://localhost:5175', cookie_file=cookie) as client:
                with self.assertRaisesRegex(ValueError, 'not an admin'):client.require_admin('project')
            self.assertFalse(any(url.endswith('/auth/logout') for _, url, _ in session.calls))
    def test_bad_login_has_no_secret_or_data_requests(self):
        session = Session(login_status=401)
        with patch('local_admin_api.requests.Session', return_value=session):
            with self.assertRaisesRegex(ValueError, 'Login failed') as caught:
                LocalAdminAPI('http://localhost:5175', 'admin', self.path)
        self.assertNotIn('secret-test-only-password', str(caught.exception))
        self.assertEqual(len(session.calls), 1)

    def test_https_access_origin_pinning_and_transport(self):
        # Both host modes use the same HTTPS, exact-origin, borrowed human-token
        # contract. This unit uses no sockets; real Access/BIC remains a live gate.
        for origin in ['https://audio.example', 'https://audiolab-staging.account.workers.dev']:
            with self.subTest(origin=origin):
                token = self.path.parent / 'access.json'
                token.write_text(json.dumps({'origin':origin,'token':'test.payload.signature'})); os.chmod(token,0o600)
                session=Session()
                session.request_original=session.request
                def request(method,url,**kwargs):
                    response=session.request_original(method,url,**kwargs)
                    if url.endswith('/auth/session'): response.payload['user']['mode']='access'
                    return response
                session.request=request
                with patch('local_admin_api.requests.Session', return_value=session):
                    with LocalAdminAPI(origin,auth='access',access_token_file=token) as client:
                        client.require_admin('project')
                        self.assertFalse(session.trust_env)
                        self.assertEqual(session.headers['Origin'], origin)
                        self.assertEqual(session.headers['Cookie'],'CF_Authorization=test.payload.signature')
                        self.assertFalse(any(url.endswith('/auth/login') for _,url,_ in session.calls))
                        with self.assertRaises(ValueError): client.request('POST','/api/v1/projects',verify=False)
                        with self.assertRaises(ValueError): client.request('POST','/api/v1/projects',headers={'Origin':'https://other.example'})
                        with self.assertRaises(ValueError): client.request('GET','https://other.example/api/v1/projects')
                        self.assertTrue(all(not kwargs['allow_redirects'] for _,_,kwargs in session.calls))
                    self.assertFalse(any(url.endswith('/auth/logout') for _,url,_ in session.calls))
                for wrong in ['https://other.example', origin.replace('https:', 'http:'), 'https://preview-audiolab-staging.account.workers.dev']:
                    with self.assertRaises(ValueError):LocalAdminAPI(wrong,auth='access',access_token_file=token)
                with self.assertRaises(ValueError):LocalAdminAPI(origin,auth='access',access_token_file=token,credentials_file=self.path)

    def test_access_expiry_redirect_and_bad_envelopes(self):
        token=self.path.parent/'access.json';os.chmod(self.path,0o600)
        for value in [[],{}, {'origin':'https://audio.example','token':'a.b.c;bad'}]:
            token.write_text(json.dumps(value));os.chmod(token,0o600)
            with self.assertRaises(ValueError):LocalAdminAPI('https://audio.example',auth='access',access_token_file=token)
        token.write_text(json.dumps({'origin':'https://audio.example','token':'a.b.c'}))
        for status in [302,401,403]:
            session=Session()
            session.request=lambda *args,**kwargs:Response(status)
            with patch('local_admin_api.requests.Session',return_value=session):
                with self.assertRaises(ValueError) as result:LocalAdminAPI('https://audio.example',auth='access',access_token_file=token)
            self.assertNotIn('a.b.c',str(result.exception))

    def test_cli_json_and_demo_credentials(self):
        self.path.write_text(json.dumps({'accounts': [{'username': 'admin', 'password': 'secret-test-only-password'}]}))
        with patch('local_admin_api.requests.Session', return_value=Session()):
            with LocalAdminAPI('http://localhost:5175', credentials_file=self.path) as client:self.assertEqual(client.user_id, 'actual-user')
        demo = self.path.parent / 'demo-login.txt';demo.write_text('Local demo only. Admin: demo-admin\nsecret-test-only-password\n');os.chmod(demo, 0o600)
        with patch('local_admin_api.requests.Session', return_value=Session()):
            with LocalAdminAPI('http://localhost:5175', 'demo-admin', demo):pass


if __name__ == '__main__':unittest.main(verbosity=2)
