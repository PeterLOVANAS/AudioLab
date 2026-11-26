#!/usr/bin/env python3
"""Real Worker/D1/R2 export: final-only provenance, batch scope and downloadable ZIP."""
import argparse,pathlib,json,uuid,requests,zipfile,io,hashlib
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state-root',required=True);p.add_argument('--base-url',default='http://127.0.0.1:5175');mode=p.add_mutually_exclusive_group(required=True);mode.add_argument('--definition-id',type=uuid.UUID);mode.add_argument('--prepare-fixture',action='store_true');a=p.parse_args();root=pathlib.Path(a.state_root);base=a.base_url.rstrip('/')
assert (root/'DISPOSABLE_DEMO.json').is_file() and base.startswith(('http://127.0.0.1:','http://localhost:'))
password=(root/'demo-login.txt').read_text().splitlines()[-1]
def login(name):
 s=requests.Session();s.trust_env=False;s.headers['Origin']=base;r=s.post(base+'/api/v1/auth/login',json={'username':name,'password':password});assert r.ok,r.text;return s
admin=login('demo-admin')
def call(client,method,path,body=None,status=200):
 r=client.request(method,base+'/api/v1/'+path,json=body,timeout=180);assert r.status_code==status,(path,r.status_code,r.text[:1500]);return r.json()
projects=call(admin,'GET','projects')['projects'];pid=next(p['id'] for p in projects if p['name']=='AudioLab Research');other=next(p['id'] for p in projects if p['name']=='PES TextGrid Local Test')
cat=call(admin,'GET','team-jobs?action=catalog&projectId='+pid);dataset=next(d for d in cat['datasets'] if d['name']=='MMAU test-mini');items=call(admin,'GET',f'team-jobs?action=items&projectId={pid}&datasetId={dataset["id"]}')['items'][:2]
options=[{'id':'label-'+str(i),'label':'Class '+str(i)} for i in range(7)]
draft={'name':'API Research Export fixture '+str(uuid.uuid4())[:6],'description':'Synthetic final/draft export regression','domain':'sound','instructions':'Keep each recording and whole-task answer distinct.','policy':{'requiredIndependentVotes':2,'blindToOthers':True,'requiresReview':False},'blocks':[
 {'id':'choice','type':'single_choice','label':'Bound question','required':True,'numBatch':2,'options':options[:2],'sourceBindings':{'label':{'kind':'dataset','fieldId':'question','type':'string'},'options':{'kind':'dataset','fieldId':'choices','type':'string[]','format':'array'}}},
 {'id':'multi','type':'multiple_choice','label':'Seven labels','required':True,'numBatch':2,'options':options},
 {'id':'rank','type':'ranking','label':'Rank labels','required':True,'rankingMode':'labels','rankLabels':options[:3]},
 {'id':'rank-audio','type':'ranking','label':'Rank recordings','required':True,'rankingMode':'audios','stimulusSlots':['Recording A','Recording B']},
 {'id':'compare','type':'audio_comparison','label':'Preferred recording','required':True,'numBatch':2,'comparisonSize':2,'options':[{'id':'left','label':'First recording'},{'id':'right','label':'Second recording'}]},
 {'id':'text','type':'text','label':'Describe each audio','required':True,'numBatch':2},
]}
if a.prepare_fixture:
 created=call(admin,'POST','task-definitions',{'projectId':pid,'draft':draft},201)['taskDefinition']
 print('Prepared validated historical-fixture draft:',created['id']);print('Stop the disposable server, seed_research_export_fixture.py with this ID, restart, then rerun with --definition-id.')
 call(admin,'POST','auth/logout',{});raise SystemExit(0)
created=call(admin,'GET','task-definitions/'+str(a.definition_id))['taskDefinition'];assert created['publishedVersion']==1
body={'jobId':str(uuid.uuid4()),'projectId':pid,'name':'API — Research Export final-only fixture','datasetId':dataset['id'],'definitionId':created['id'],'definitionVersion':1,'mode':'voting','seed':'export-order','itemKeys':[i['key'] for i in items],'sampleCount':2,'workerIds':['demo-alice','demo-bob','demo-chai']}
plan=call(admin,'POST','team-jobs?action=preview',body)['plan'];job=call(admin,'POST','team-jobs?action=launch',{**plan['input'],'expectedHash':plan['hash']});assert len(job['assignments'])==3
expected={}
for index,name in enumerate(['demo-alice','demo-bob','demo-chai']):
 client=login(name);assignment=next(a for a in job['assignments'] if a['userId']==name);aid=assignment['id'];task=call(client,'GET','assignments/'+aid)['taskInstance'];choice=next(b for b in task['resolvedDefinition']['blocks'] if b['id']=='choice')
 answers={'choice':[b['options'][index%2]['id'] for b in choice['batchBlocks']],'multi':[['label-0','label-6'],['label-3','label-6']],'rank':['label-2','label-0','label-1'],'rank-audio':['slot-1','slot-0'],'compare':['left' if index==0 else 'right'],'text':['final text zero','final text one']}
 if index==1:answers['rank']=['label-1','label-0','label-2']
 if index==2:answers['text']=['DRAFT_ONLY_SECRET_SENTINEL','DRAFT_ONLY_SECRET_SENTINEL']
 call(client,'POST',f'assignments/{aid}/annotation/draft',{'labellerId':name,'expectedRevision':0,'answers':answers},201)
 if index<2:call(client,'POST',f'assignments/{aid}/annotation/submit',{'labellerId':name,'expectedRevision':1,'answers':answers},201);expected[name]=answers
 call(client,'POST','auth/logout',{})
path=f'research-export?projectId={pid}&jobId={body["jobId"]}'
data=call(admin,'GET',path);assert data['schemaVersion']=='audiolab.research-export/1';assert data['job']['submitted']==2;assert data['totals']['exportedSubmissions']==2 and data['totals']['expectedSubmissions']==3 and data['totals']['annotatedAudio']==2
serialized=json.dumps(data);assert 'DRAFT_ONLY_SECRET_SENTINEL' not in serialized;assert 'source_labels' not in serialized and 'reference_answer' not in serialized
assert len(data['tasks'])==1 and [r['answers'] for r in data['tasks'][0]['annotations'] if r['workerId']=='demo-alice']==[expected['demo-alice']]
for position,audio in enumerate(data['audioItems']):
 source=audio['sourceItems'][0];assert source['fieldsOrigin']=='pinned-task-input';assert source['sourceKey']==plan['batches'][0]['itemKeys'][position]
 projected={b['block']['id']:b for b in source['blocks']};assert 'rank' not in projected and 'rank-audio' not in projected and 'compare' not in projected
 assert len(projected['multi']['distribution']['counts'])==7 and projected['multi']['distribution']['submitted']==2
 assert sorted(c['count'] for c in projected['choice']['distribution']['counts'])==[0,0,1,1]
 for annotation in projected['text']['annotations']:assert annotation['value']==expected[annotation['workerId']]['text'][position]
 assert any(field['id']=='question' for field in source['fields']) and any(field['id']=='choices' for field in source['fields'])
 single=call(admin,'GET',path+'&format=audio-json&audioId='+audio['audioId']);assert single['audio']['audioId']==audio['audioId'];assert single['taskInstances'][0]['annotationScope']=='task-instance'
comparison=next(v for v in data['tasks'][0]['distributions'] if v['blockId']=='compare');assert comparison['comparisonIndex']==0 and [v['count'] for v in comparison['value']['counts']]==[1,1]
for format in ['json-zip','audio-zip']:
 response=admin.get(base+'/api/v1/'+path+'&format='+format,timeout=180);assert response.status_code==200,response.text[:1000];assert response.headers['cache-control']=='no-store';assert response.headers['content-type'].startswith('application/zip')
 archive=zipfile.ZipFile(io.BytesIO(response.content));assert archive.testzip() is None
 assert 'job.json' in archive.namelist()
 for audio in data['audioItems']:
  record=json.loads(archive.read('annotations/'+audio['audioId']+'.json'));assert record['audio']['audioId']==audio['audioId']
  assert record['taskInstances'][0]['annotations'][0]['revisionId']
  if format=='audio-zip':
   raw=archive.read('audio/'+audio['audioId']+'.wav');assert raw[:4]==b'RIFF'
   live=admin.get(base+audio['audioUrl'],timeout=60);assert hashlib.sha256(raw).digest()==hashlib.sha256(live.content).digest()
  else:assert not any(name.startswith('audio/') for name in archive.namelist())
 response_data=response.content
(root/'RESEARCH_EXPORT_EVIDENCE.json').write_text(json.dumps({'jobId':body['jobId'],'projectId':pid,'taskId':data['tasks'][0]['id'],'annotatedAudio':2,'finals':2,'draftsExcluded':True,'zipBytes':len(response_data)},indent=2))
(root/'research-export-test.zip').write_bytes(response_data)
# Independent allocation renders the actual saved block values, without vote bars.
individual={**body,'jobId':str(uuid.uuid4()),'name':'API — Research Export individual fixture','mode':'individual','workerIds':['demo-alice']}
ip=call(admin,'POST','team-jobs?action=preview',individual)['plan'];ij=call(admin,'POST','team-jobs?action=launch',{**ip['input'],'expectedHash':ip['hash']})
alice=login('demo-alice');ia=ij['assignments'][0]
call(alice,'POST',f'assignments/{ia["id"]}/annotation/submit',{'labellerId':'demo-alice','expectedRevision':0,'answers':expected['demo-alice']},201)
ind=call(admin,'GET',f'research-export?projectId={pid}&jobId={individual["jobId"]}');assert ind['job']['submitted']==1
assert all('distribution' not in block for audio in ind['audioItems'] for item in audio['sourceItems'] for block in item['blocks'])
assert ind['tasks'][0]['annotations'][0]['answers']==expected['demo-alice']
call(alice,'POST','auth/logout',{})
call(admin,'POST','team-jobs?action=delete',{'projectId':pid,'jobId':individual['jobId']})
assert individual['jobId'] not in [job['id'] for job in call(admin,'GET','team-jobs?projectId='+pid)['jobs']]
assert any(job['id']==individual['jobId'] and job['deletedAt'] for job in call(admin,'GET','team-jobs?projectId='+pid+'&includeArchived=1')['jobs'])
archived=call(admin,'GET',f'research-export?projectId={pid}&jobId={individual["jobId"]}');assert archived['job']['deletedAt'] and archived['totals']['exportedSubmissions']==1
# Existing real Grounding finals reuse the same safe per-audio projection.
old=json.loads((root/'TEAM_HTTP_EVIDENCE.json').read_text())
ground=call(admin,'GET',f'research-export?projectId={old["projectId"]}&jobId={old["groundingJob"]}')
assert ground['totals']['exportedSubmissions']==2
assert any(block['block']['type']=='timeline_annotation' and len(block['annotations'])==2 for audio in ground['audioItems'] for item in audio['sourceItems'] for block in item['blocks'])
# The production boundary must protect preview AND downloadable binary data.
worker=login('demo-alice');call(worker,'GET',path,status=403);call(worker,'GET',path+'&format=audio-zip',status=403);call(worker,'POST','auth/logout',{})
call(admin,'GET',f'research-export?projectId={other}&jobId={body["jobId"]}',status=403)
call(admin,'GET',path+'&format=audio-json&audioId='+str(uuid.uuid4()),status=404)
call(admin,'GET',path+'&format=bad',status=400)
call(admin,'POST','auth/logout',{});call(admin,'GET',path,status=401)
print('PASS actual Worker/D1/R2: final-only incomplete-job export, batched source/choice/text identity, seven-choice Voting bars, Ranking/Audio Comparison whole-task provenance, matching JSON/WAV ZIPs with verified bytes, draft exclusion and admin/project/audio authorization.')
print('Disposable export job:',body['jobId'])
