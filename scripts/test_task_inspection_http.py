#!/usr/bin/env python3
"""Authenticated inspection/metadata regression on the isolated loopback demo."""
import io, json, pathlib, wave, requests
root=pathlib.Path('/var/folders/5b/sk_7519j5614mpc0nwd985k80000gn/T/audiolab-assignment-demo-um20ruxy')
assert (root/'DISPOSABLE_DEMO.json').is_file()
base='http://127.0.0.1:5175';secret=(root/'demo-login.txt').read_text().splitlines()[-1];ids=json.loads((root/'TEAM_DEMO.json').read_text())
s=requests.Session();s.trust_env=False;s.headers['Origin']=base

def call(method,path,body=None,expected=200):
 r=s.request(method,base+'/api/v1/'+path,json=body,timeout=60)
 assert r.status_code==expected,(path,r.status_code,r.text[:300]);return r.json()
call('POST','auth/login',{'username':'demo-admin','password':secret})
projects=call('GET','projects')['projects'];names=[]
for project in projects:
 for dataset in call('GET','datasets?projectId='+project['id'])['datasets']:
  names.append(dataset['name'])
  assets=call('GET','assets?datasetId='+dataset['id'])['assets']
  assert all(a.get('durationSeconds',0)>0 for a in assets)
assert {'MMAU test-mini','PES-corpus'}<=set(names)
pid=ids['projectId'];jobs=call('GET','team-jobs?projectId='+pid)['jobs']
job=next(j for j in jobs if j['name']=='API — Completed Voting classification')
detail=call('GET',f'team-jobs?action=detail&projectId={pid}&jobId={job["id"]}')
a=next(a for a in detail['assignments'] if a['userId']=='demo-alice')
path=f'team-jobs?action=task&projectId={pid}&jobId={job["id"]}&assignmentId={a["id"]}'
inspection=call('GET',path);task=inspection['taskInstance']
assert task['audioAssets'][0]['durationSeconds']>0
assert inspection['current']['answers']['classification']=='speech'
# New uploads must store metadata at registration, without requiring repair.
data=io.BytesIO()
with wave.open(data,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b'\x00'*32000)
assets=call('GET','assets?datasetId='+ids['datasetId'])['assets']
if not any(a['originalPath']=='metadata-regression.wav' for a in assets):
 r=s.post(base+'/api/v1/assets',data={'datasetId':ids['datasetId'],'originalPath':'metadata-regression.wav'},files={'audio':('metadata-regression.wav',data.getvalue(),'audio/wav')});assert r.status_code==201,r.text
 assert r.json()['asset']['durationSeconds']==1
assets=call('GET','assets?datasetId='+ids['datasetId'])['assets'];assert next(a for a in assets if a['originalPath']=='metadata-regression.wav')['durationSeconds']==1
call('POST','auth/logout',{})
call('POST','auth/login',{'username':'demo-alice','password':secret})
own=call('GET','assignments/'+a['id'])['taskInstance']
assert own['resolvedDefinition']==task['resolvedDefinition']
assert own['audioAssets']==task['audioAssets']
saved=call('GET',f'assignments/{a["id"]}/annotation?labellerId=demo-alice')['current']
assert saved['answers']==inspection['current']['answers']
call('GET',path,expected=403)
call('POST','assets/'+own['assetId']+'/metadata',{},expected=403)
call('POST','auth/logout',{})
print('PASS copied MMAU/PES visible, durations populated, new WAV upload persists 1s, admin inspection matches owner Workspace pinned form/audio/answers, labeller denied admin inspection/metadata writes.')
