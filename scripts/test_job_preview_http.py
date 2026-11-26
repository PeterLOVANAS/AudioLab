#!/usr/bin/env python3
"""Preview real MMAU/PES allocations; confirm no jobs are persisted by preview."""
import argparse,json,pathlib,uuid,requests
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state-root',required=True);p.add_argument('--base-url',default='http://127.0.0.1:5175');a=p.parse_args()
root=pathlib.Path(a.state_root);base=a.base_url.rstrip('/')
assert (root/'DISPOSABLE_DEMO.json').is_file() and base.startswith(('http://127.0.0.1:','http://localhost:'))
s=requests.Session();s.trust_env=False;s.headers['Origin']=base

def call(method,path,body=None):
 r=s.request(method,base+'/api/v1/'+path,json=body,timeout=60);assert r.ok,(path,r.status_code,r.text[:1000]);return r.json()
call('POST','auth/login',{'username':'demo-admin','password':(root/'demo-login.txt').read_text().splitlines()[-1]})
for project in call('GET','projects')['projects']:
 if project['name'] not in ['AudioLab Research','PES TextGrid Local Test']:continue
 pid=project['id'];catalog=call('GET','team-jobs?action=catalog&projectId='+pid)
 definition=next(d for d in catalog['definitions'] if d['name']==('MMAU_QA' if project['name']=='AudioLab Research' else 'PES automatic TextGrid — 2 audio'))
 size=next(v['recordingsPerTask'] for v in definition['versions'] if v['version']==definition['publishedVersion']);count=(10//size)*size
 dataset=catalog['datasets'][0];items=call('GET',f'team-jobs?action=items&projectId={pid}&datasetId={dataset["id"]}')['items'][:count]
 before=call('GET','team-jobs?projectId='+pid)['jobs']
 body={'jobId':str(uuid.uuid4()),'projectId':pid,'name':'Preview regression only','datasetId':dataset['id'],'definitionId':definition['id'],'definitionVersion':definition['publishedVersion'],'mode':'voting','seed':'preview-test','itemKeys':[i['key'] for i in items],'sampleCount':count,'workerIds':['demo-alice','demo-chai']}
 plan=call('POST','team-jobs?action=preview',body)['plan'];assert len(plan['pairs'])==count//size*2 and len(plan['items'])==count and all(len(batch['itemKeys'])==size for batch in plan['batches'])
 assert call('GET','team-jobs?projectId='+pid)['jobs']==before
 print('PASS',dataset['name'],definition['name'],f'preview {count} items / {count//size} batches / {count//size*2} assignments; no job persisted')
call('POST','auth/logout',{})
