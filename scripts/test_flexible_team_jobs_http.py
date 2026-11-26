#!/usr/bin/env python3
"""Actual Worker/D1: full dataset, partial final task, mixed Grounding and delete."""
import argparse,pathlib,uuid,requests
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state-root',required=True);p.add_argument('--base-url',default='http://127.0.0.1:5175');a=p.parse_args();root=pathlib.Path(a.state_root);base=a.base_url.rstrip('/')
assert (root/'DISPOSABLE_DEMO.json').is_file() and base.startswith(('http://127.0.0.1:','http://localhost:'))
password=(root/'demo-login.txt').read_text().splitlines()[-1]
def login(username):
 client=requests.Session();client.trust_env=False;client.headers['Origin']=base
 result=client.post(base+'/api/v1/auth/login',json={'username':username,'password':password});assert result.ok,result.text
 return client
admin=login('demo-admin')
def call(client,method,path,body=None,status=200):
 r=client.request(method,base+'/api/v1/'+path,json=body,timeout=180);assert r.status_code==status,(path,r.status_code,r.text[:1800]);return r.json()
projects=call(admin,'GET','projects')['projects'];pid=next(p['id'] for p in projects if p['name']=='AudioLab Research');other=next(p['id'] for p in projects if p['name']=='PES TextGrid Local Test')
# Only retire earlier interrupted runs of these explicitly named synthetic tests.
for old in call(admin,'GET','team-jobs?projectId='+pid)['jobs']:
 if old['name'] in ['API — entire MMAU flexible test','API — final leftover and Grounding tabs']:
  call(admin,'POST','team-jobs?action=delete',{'projectId':pid,'jobId':old['id']})
cat=call(admin,'GET','team-jobs?action=catalog&projectId='+pid);definition=next(d for d in cat['definitions'] if d['name']=='MMAU_QA');dataset=next(d for d in cat['datasets'] if d['name']=='MMAU test-mini');assert dataset['itemCount']==100
items=call(admin,'GET',f'team-jobs?action=items&projectId={pid}&datasetId={dataset["id"]}')['items']
body={'jobId':str(uuid.uuid4()),'projectId':pid,'name':'API — entire MMAU flexible test','datasetId':dataset['id'],'definitionId':definition['id'],'definitionVersion':1,'mode':'voting','seed':'flexible-tests','itemKeys':[],'sampleCount':100,'useEntireDataset':True,'workerIds':['demo-alice','demo-chai']}
whole=call(admin,'POST','team-jobs?action=preview',body)['plan'];assert len(whole['items'])==100 and len(whole['batches'])==25 and len(whole['pairs'])==50
wj=call(admin,'POST','team-jobs?action=launch',{**whole['input'],'expectedHash':whole['hash']});assert len(wj['assignments'])==50
print('PASS actual entire MMAU dataset: 100 items / 25 four-audio tasks / 50 independent assignments.',flush=True)
body.update(jobId=str(uuid.uuid4()),name='API — final leftover and Grounding tabs',useEntireDataset=False,itemKeys=[i['key'] for i in items[:9]],sampleCount=9)
plan=call(admin,'POST','team-jobs?action=preview',body)['plan'];assert [len(b['itemKeys']) for b in plan['batches']]==[4,4,1]
job=call(admin,'POST','team-jobs?action=launch',{**plan['input'],'expectedHash':plan['hash']});assert len(job['assignments'])==6
assert len(call(admin,'POST','team-jobs?action=launch',{**plan['input'],'expectedHash':plan['hash']})['assignments'])==6
last_aid=None
overview_before=call(login('demo-alice'),'GET',f'labeller/overview?projectId={pid}&labellerId=demo-alice')['counts']['total']
for username in ['demo-alice','demo-chai']:
 client=login(username)
 for assignment in [a for a in job['assignments'] if a['userId']==username]:
  aid=assignment['id'];task=call(client,'GET','assignments/'+aid)['taskInstance'];n=len(assignment['itemKeys']);assert len(task['audioAssets'])==n
  original_choice=next(b for b in task['definition']['blocks'] if b['type']=='single_choice');assert original_choice['numBatch']==4
  original_ground=next(b for b in task['definition']['blocks'] if b['type']=='timeline_annotation');assert original_ground.get('numBatch',1)==1
  blocks=task['resolvedDefinition']['blocks'];choice=next(b for b in blocks if b['type']=='single_choice');ground=next(b for b in blocks if b['type']=='timeline_annotation')
  assert choice['numBatch']==n and ground.get('numBatch',1)==n
  if n>1:assert ground['audioNavigation']=='tabs'
  choices=[b['options'][0]['id'] for b in choice['batchBlocks']] if n>1 else choice['options'][0]['id']
  ground_values=[{'tiers':{tier['id']:[{'id':str(uuid.uuid4()),'start':0,'end':.01*(index+1),'text':'slot-'+str(index)}] for tier in ground['tiers']}} for index in range(n)]
  answers={choice['id']:choices,ground['id']:ground_values if n>1 else ground_values[0]}
  call(client,'POST',f'assignments/{aid}/annotation/draft',{'labellerId':username,'expectedRevision':0,'answers':answers},201)
  saved=call(client,'GET',f'assignments/{aid}/annotation?labellerId={username}')['current'];assert saved['answers']==answers
  call(client,'POST',f'assignments/{aid}/annotation/submit',{'labellerId':username,'expectedRevision':1,'answers':answers},201)
  assert call(client,'GET',f'assignments/{aid}/annotation?labellerId={username}')['current']['answers']==answers
  if username=='demo-alice':last_aid=aid
 call(client,'POST','team-jobs?action=delete',{'projectId':pid,'jobId':body['jobId']},403)
 call(client,'POST','auth/logout',{})
detail=call(admin,'GET',f'team-jobs?action=detail&projectId={pid}&jobId={body["jobId"]}');assert detail['summary']['fullyLabelledItems']==9
results=call(admin,'GET',f'team-jobs?action=results&projectId={pid}&jobId={body["jobId"]}');assert results['complete'];choice=next(b for b in results['blocks'] if b['type']=='single_choice');assert sum(v['count'] for v in choice['counts'])==18 and choice['validComparisons']==9
call(admin,'POST','team-jobs?action=delete',{'projectId':other,'jobId':body['jobId']},403)
for plan_to_delete in [whole,plan]:
 result=call(admin,'POST','team-jobs?action=delete',{'projectId':pid,'jobId':plan_to_delete['input']['jobId']});assert result['historyPreserved']
 call(admin,'POST','team-jobs?action=delete',{'projectId':pid,'jobId':plan_to_delete['input']['jobId']})
 call(admin,'POST','team-jobs?action=launch',{**plan_to_delete['input'],'expectedHash':plan_to_delete['hash']},410)
active=call(admin,'GET','team-jobs?projectId='+pid)['jobs'];assert body['jobId'] not in [j['id'] for j in active]
alice=login('demo-alice');queue=call(alice,'GET',f'labeller/assigned-queue?projectId={pid}&labellerId=demo-alice&queueJobId={body["jobId"]}');assert queue['totalCompleteGroups']==0 and not queue['groups']
assert call(alice,'GET',f'labeller/overview?projectId={pid}&labellerId=demo-alice')['counts']['total']==overview_before-28
legacy=call(alice,'GET',f'labeller/queue?projectId={pid}&labellerId=demo-alice')['assignments'];assert not any(a['id'] in {x['id'] for x in wj['assignments']} for a in legacy)
paged=call(alice,'GET',f'labeller/queue/page?projectId={pid}&labellerId=demo-alice')['assignments'];assert not any(a['id'] in {x['id'] for x in wj['assignments']} for a in paged)
assert call(alice,'GET',f'assignments/{last_aid}/annotation?labellerId=demo-alice')['current']['answers']
call(alice,'POST',f'assignments/{last_aid}/annotation/draft',{'labellerId':'demo-alice','expectedRevision':2,'answers':{}},410)
call(alice,'POST','auth/logout',{});call(admin,'POST','auth/logout',{})
print('PASS [4,4,1] final runtime batch, published definitions unchanged, mixed Grounding per-audio values, draft/final/reopen, source progress/statistics, duplicate launch and soft deletion with read-only history/permission enforcement.')
