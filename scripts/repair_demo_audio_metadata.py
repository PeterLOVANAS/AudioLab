#!/usr/bin/env python3
"""Backfill WAV metadata through authenticated APIs on the disposable demo only.
Never edits SQLite directly, uploads media, or accepts preserved state paths.
"""
import argparse, pathlib, tempfile, requests
from urllib.parse import urlparse
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--state-root',required=True)
p.add_argument('--base-url',default='http://127.0.0.1:5175')
p.add_argument('--apply',action='store_true')
a=p.parse_args();root=pathlib.Path(a.state_root).resolve();base=a.base_url.rstrip('/')
if pathlib.Path(tempfile.gettempdir()).resolve() not in root.parents or not (root/'DISPOSABLE_DEMO.json').is_file() or urlparse(base).hostname not in ('127.0.0.1','localhost'):
    raise SystemExit('Disposable loopback demo only')
s=requests.Session();s.trust_env=False;s.headers['Origin']=base

def call(method,path,body=None):
    r=s.request(method,base+'/api/v1/'+path,json=body,timeout=60)
    if not r.ok: raise RuntimeError(f'{path}: HTTP {r.status_code}: {r.text[:200]}')
    return r.json()
call('POST','auth/login',{'username':'demo-admin','password':(root/'demo-login.txt').read_text().splitlines()[-1]})
for project in call('GET','projects')['projects']:
    for dataset in call('GET','datasets?projectId='+project['id'])['datasets']:
        assets=call('GET','assets?datasetId='+dataset['id'])['assets'];fixed=0
        for asset in assets:
            if not asset.get('durationSeconds') and a.apply:
                data=call('POST','assets/'+asset['id']+'/metadata',{})['metadata']
                assert data['durationSeconds']>0;fixed+=1
        current=call('GET','assets?datasetId='+dataset['id'])['assets']
        print(dataset['name'], 'assets',len(current),'with duration',sum(bool(x.get('durationSeconds')) for x in current),'repaired',fixed)
call('POST','auth/logout',{})
