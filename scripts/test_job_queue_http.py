#!/usr/bin/env python3
"""Focused real Worker/D1 job picker, paging and saved-team regression."""
import argparse,json,pathlib,uuid,requests
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state-root',required=True);p.add_argument('--base-url',default='http://127.0.0.1:5175');a=p.parse_args()
root=pathlib.Path(a.state_root);base=a.base_url.rstrip('/')
assert (root/'DISPOSABLE_DEMO.json').is_file() and base.startswith(('http://127.0.0.1:','http://localhost:'))
password=(root/'demo-login.txt').read_text().splitlines()[-1];ids=json.loads((root/'TEAM_DEMO.json').read_text());evidence=json.loads((root/'TEAM_HTTP_EVIDENCE.json').read_text());pid=ids['projectId']
s=requests.Session();s.trust_env=False;s.headers['Origin']=base

def call(method,path,body=None,status=200):
 r=s.request(method,base+'/api/v1/'+path,json=body,timeout=60);assert r.status_code==status,(path,r.status_code,r.text[:300]);return r.json()
call('POST','auth/login',{'username':'demo-admin','password':password})
projects=call('GET','projects')['projects'];datasets=[]
for project in projects:
 datasets.extend(call('GET','datasets?projectId='+project['id'])['datasets'])
assert {'MMAU test-mini','PES-corpus'}<=set(d['name'] for d in datasets)
created=call('POST','worker-profiles?action=team',{'projectId':pid,'name':'Save-team test '+str(uuid.uuid4())[:8],'memberIds':['demo-alice','demo-chai']})
tid=created['teamId'];assert next(t for t in created['teams'] if t['id']==tid)['memberIds']==['demo-alice','demo-chai']
updated=call('POST','worker-profiles?action=team',{'projectId':pid,'teamId':tid,'name':'Updated saved team '+tid[:8],'memberIds':['demo-alice']})
assert updated['teamId']==tid and next(t for t in updated['teams'] if t['id']==tid)['memberIds']==['demo-alice']
call('POST','auth/logout',{})
call('POST','auth/login',{'username':'demo-alice','password':password})
path=f'labeller/assigned-queue?projectId={pid}&labellerId=demo-alice'
all_jobs=call('GET',path+'&limit=1')['jobs'];assert next(j for j in all_jobs if j['id']==evidence['votingJob'])['total']==10
selected=path+'&limit=3&queueJobId='+evidence['votingJob'];first=call('GET',selected)
assert first['totalCompleteGroups']==10 and first['totalSubmitted']==10 and first['hasMore']
assert len(first['groups'])==3 and all(g['jobId']==evidence['votingJob'] for g in first['groups'])
second=call('GET',selected+'&cursor='+first['nextCursor']);assert not set(g['key'] for g in first['groups']) & set(g['key'] for g in second['groups'])
assert call('GET',path+'&queueJobId='+str(uuid.uuid4()))['totalCompleteGroups']==0
call('GET',path+'&queueJobId=invalid',status=400)
call('GET',f'labeller/assigned-queue?projectId={pid}&labellerId=demo-bob',status=403)
call('POST','worker-profiles?action=team',{'projectId':pid,'name':'unauthorized','memberIds':['demo-alice']},status=403)
call('POST','auth/logout',{})
print('PASS authorized MMAU/PES discovery, saved-team ID/create/update, owner-scoped job discovery across pages, filtered counts/paging, invalid filter and impersonation/worker-write rejection.')
