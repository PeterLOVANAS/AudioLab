#!/usr/bin/env python3
"""Actual local D1: batch allocation → ordered sources → draft/submit/reopen."""
import argparse,pathlib,uuid,requests,json
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state-root',required=True);p.add_argument('--base-url',default='http://127.0.0.1:5175');a=p.parse_args();root=pathlib.Path(a.state_root);base=a.base_url.rstrip('/')
assert (root/'DISPOSABLE_DEMO.json').is_file() and base.startswith(('http://127.0.0.1:','http://localhost:'))
password=(root/'demo-login.txt').read_text().splitlines()[-1]
def login(username):
 s=requests.Session();s.trust_env=False;s.headers['Origin']=base
 r=s.post(base+'/api/v1/auth/login',json={'username':username,'password':password});assert r.ok,r.text
 return s
admin=login('demo-admin')
def call(client,method,path,body=None,status=200):
 r=client.request(method,base+'/api/v1/'+path,json=body,timeout=90);assert r.status_code==status,(path,r.status_code,r.text[:1800]);return r.json()
pid=next(p['id'] for p in call(admin,'GET','projects')['projects'] if p['name']=='AudioLab Research')
catalog=call(admin,'GET','team-jobs?action=catalog&projectId='+pid);definition=next(d for d in catalog['definitions'] if d['name']=='MMAU_QA');dataset=next(d for d in catalog['datasets'] if d['name']=='MMAU test-mini')
items=call(admin,'GET',f'team-jobs?action=items&projectId={pid}&datasetId={dataset["id"]}')['items'][:12]
body={'jobId':str(uuid.uuid4()),'projectId':pid,'name':'API — NUM_BATCH=4 regression '+str(uuid.uuid4())[:6],'datasetId':dataset['id'],'definitionId':definition['id'],'definitionVersion':1,'mode':'voting','seed':'batch-regression','itemKeys':[i['key'] for i in items],'sampleCount':8,'workerIds':['demo-alice','demo-chai']}
plan=call(admin,'POST','team-jobs?action=preview',body)['plan'];assert len(plan['batches'])==2 and len(plan['pairs'])==4
launch=dict(plan['input'],expectedHash=plan['hash']);job=call(admin,'POST','team-jobs?action=launch',launch);assert len(job['assignments'])==4
assert len(call(admin,'POST','team-jobs?action=launch',launch)['assignments'])==4
assert job['summary']['fullyLabelledItems']==0
for worker_index,username in enumerate(['demo-alice','demo-chai']):
 client=login(username);mine=[x for x in job['assignments'] if x['userId']==username];assert len(mine)==2
 for index,assignment in enumerate(mine):
  aid=assignment['id'];task=call(client,'GET','assignments/'+aid)['taskInstance'];batch=next(b for b in plan['batches'] if b['key']==assignment['itemKey']);members=[next(i for i in plan['items'] if i['key']==key) for key in batch['itemKeys']]
  assert [x['id'] for x in task['audioAssets']]==[i['assetId'] for i in members]
  assert len(set(x['id'] for x in task['audioAssets']))==4
  choices=next(b for b in task['resolvedDefinition']['blocks'] if b['type']=='single_choice');assert len(choices['batchBlocks'])==4
  assert [b['label'] for b in choices['batchBlocks']]==[i['question'] for i in members]
  answers={choices['id']:[b['options'][worker_index]['id'] for b in choices['batchBlocks']]}
  ground=next(b for b in task['resolvedDefinition']['blocks'] if b['type']=='timeline_annotation')
  one_ground={'tiers':{t['id']:[{'id':'event','start':0,'end':.01,'text':'test'}] for t in ground['tiers']}}
  answers[ground['id']]=[one_ground for _ in range(ground.get('numBatch',1))] if ground.get('numBatch',1)>1 else one_ground
  if index==0:
   bad={**answers,choices['id']:['not-an-option']+answers[choices['id']][1:]}
   call(client,'POST',f'assignments/{aid}/annotation/submit',{'labellerId':username,'expectedRevision':0,'answers':bad},422)
   call(client,'POST',f'assignments/{aid}/annotation/draft',{'labellerId':username,'expectedRevision':0,'answers':answers},201)
  call(client,'POST',f'assignments/{aid}/annotation/submit',{'labellerId':username,'expectedRevision':1 if index==0 else 0,'answers':answers},201)
  saved=call(client,'GET',f'assignments/{aid}/annotation?labellerId={username}')['current'];assert saved['answers']==answers
  audio=client.get(base+task['audioAssets'][3]['url'],headers={'Range':'bytes=0-11'});assert audio.status_code==206 and audio.content[:4]==b'RIFF'
 if worker_index==0:
  half=call(admin,'GET',f'team-jobs?action=detail&projectId={pid}&jobId={body["jobId"]}');assert half['summary']['fullyLabelledItems']==0
 call(client,'POST','auth/logout',{})
completed=call(admin,'GET',f'team-jobs?action=detail&projectId={pid}&jobId={body["jobId"]}');assert completed['summary']['fullyLabelledItems']==8 and completed['summary']['submitted']==4
results=call(admin,'GET',f'team-jobs?action=results&projectId={pid}&jobId={body["jobId"]}');assert results['complete'];choice=next(b for b in results['blocks'] if b['type']=='single_choice');assert sum(c['count'] for c in choice['counts'])==16 and choice['validComparisons']==8 and choice['meanSimilarity']==0
partial={**body,'jobId':str(uuid.uuid4()),'sampleCount':10};tail=call(admin,'POST','team-jobs?action=preview',partial)['plan'];assert [len(b['itemKeys']) for b in tail['batches']]==[4,4,2]
individual={**body,'jobId':str(uuid.uuid4()),'name':'API — Individual NUM_BATCH=4','mode':'individual'};ip=call(admin,'POST','team-jobs?action=preview',individual)['plan'];assert sorted(ip['counts'].values())==[1,1]
individual_job=call(admin,'POST','team-jobs?action=launch',{**ip['input'],'expectedHash':ip['hash']});assert len(individual_job['assignments'])==2
# Existing PES TextGrid prefill must also survive a real two-audio assignment.
pes_project=next(p['id'] for p in call(admin,'GET','projects')['projects'] if p['name']=='PES TextGrid Local Test')
pc=call(admin,'GET','team-jobs?action=catalog&projectId='+pes_project);pd=next(d for d in pc['definitions'] if d['name']=='PES automatic TextGrid — 2 audio');ds=pc['datasets'][0]
pi=call(admin,'GET',f'team-jobs?action=items&projectId={pes_project}&datasetId={ds["id"]}')['items'][:2]
pb={**body,'jobId':str(uuid.uuid4()),'projectId':pes_project,'name':'API — PES two-audio TextGrid regression','datasetId':ds['id'],'definitionId':pd['id'],'definitionVersion':pd['publishedVersion'],'itemKeys':[i['key'] for i in pi],'sampleCount':2}
pp=call(admin,'POST','team-jobs?action=preview',pb)['plan'];pj=call(admin,'POST','team-jobs?action=launch',{**pp['input'],'expectedHash':pp['hash']});assert len(pj['assignments'])==2
for assignment in pj['assignments']:
 user=assignment['userId'];client=login(user);aid=assignment['id'];task=call(client,'GET','assignments/'+aid)['taskInstance']
 assert len(task['audioAssets'])==2
 values=task['initialAnswers'];ground=task['resolvedDefinition']['blocks'][0]
 assert len(values[ground['id']])==2 and all(value['tiers']['words'] and value['tiers']['phones'] for value in values[ground['id']])
 call(client,'POST',f'assignments/{aid}/annotation/draft',{'labellerId':user,'expectedRevision':0,'answers':values},201)
 call(client,'POST',f'assignments/{aid}/annotation/submit',{'labellerId':user,'expectedRevision':1,'answers':values},201)
 assert call(client,'GET',f'assignments/{aid}/annotation?labellerId={user}')['current']['answers']==values
 call(client,'POST','auth/logout',{})
assert call(admin,'GET',f'team-jobs?action=detail&projectId={pes_project}&jobId={pb["jobId"]}')['summary']['fullyLabelledItems']==2
assert call(admin,'GET',f'team-jobs?action=results&projectId={pes_project}&jobId={pb["jobId"]}')['complete']
print('PASS actual PES NUM_BATCH=2: two authorized TextGrid prefills, words/phones, drafts/submissions/reopen and full source-item progress.')
call(admin,'POST','auth/logout',{})
print('PASS actual Worker/D1/R2 NUM_BATCH=4: 8 items→2 ordered task batches→4 independent assignments; idempotency, per-slot source questions/options, invalid choice rejection, draft/final/reopen and fourth-audio playback.')
print('PASS unique-item progress 0→8 after both workers submit, 16 choice answers/8 comparisons, disjoint Individual batches and explicit partial final batch. Job:',body['jobId'])
