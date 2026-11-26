#!/usr/bin/env python3
"""R02A real Worker/D1/R2 acceptance using an explicitly new temporary state only.
Run --setup with server stopped, then start loopback DEV with that state and run
without --setup. Generates synthetic tones; never reads presentation data.
"""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import secrets
import sqlite3
import struct
import tempfile
import uuid
import wave
import requests

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--state-root',type=Path,required=True)
p.add_argument('--base-url',default='http://127.0.0.1:5198')
p.add_argument('--setup',action='store_true')
a=p.parse_args();root=a.state_root.resolve();repo=Path(__file__).resolve().parents[1]
assert Path(tempfile.gettempdir()).resolve() in root.parents and repo not in root.parents
assert a.base_url=='http://127.0.0.1:5198', 'Use the isolated acceptance port'
marker=root/'R02A_FIXTURE.json';credential=root/'r02a-credentials.json'
if a.setup:
    assert not marker.exists(), 'Setup requires a fresh disposable store'
    databases=[]
    for f in (root/'v3/d1').rglob('*.sqlite'):
        with sqlite3.connect(f.as_uri()+'?mode=ro',uri=True) as c:
            if c.execute("SELECT 1 FROM sqlite_master WHERE name='projects'").fetchone():databases.append(f)
    assert len(databases)==1
    project=str(uuid.uuid4());password=secrets.token_urlsafe(24)
    with sqlite3.connect(databases[0]) as c:
        assert c.execute('SELECT count(*) FROM projects').fetchone()[0]==0,'No existing project data may be used'
        c.execute('PRAGMA foreign_keys=ON')
        c.execute('INSERT INTO projects(id,name,slug) VALUES(?,?,?)',(project,'R02A Synthetic Acceptance','r02a-synthetic'))
        for user,role in [('r02a-admin','admin'),('r02a-alice','labeller'),('r02a-bob','labeller'),('r02a-chai','labeller')]:
            salt=secrets.token_hex(16);digest=hashlib.pbkdf2_hmac('sha256',password.encode(),salt.encode(),100000).hex()
            c.execute('INSERT INTO auth_accounts(user_id,username,display_name,demo_salt,demo_password_hash) VALUES(?,?,?,?,?)',(user,user,user,salt,digest))
            c.execute('INSERT INTO project_members(project_id,user_id,display_name,role) VALUES(?,?,?,?)',(project,user,user,role))
            if role=='labeller':c.execute('INSERT INTO worker_profiles(project_id,user_id) VALUES(?,?)',(project,user))
    marker.write_text(json.dumps({'projectId':project,'database':str(databases[0])}))
    fd=os.open(credential,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:json.dump({'password':password},f)
    print('PASS new disposable schema and synthetic accounts provisioned; credentials private');raise SystemExit
assert marker.exists() and credential.exists()
fixture=json.loads(marker.read_text());project=fixture['projectId'];password=json.loads(credential.read_text())['password']

def login(user):
    c=requests.Session();c.trust_env=False;c.headers['Origin']=a.base_url
    r=c.post(a.base_url+'/api/v1/auth/login',json={'username':user,'password':password},timeout=30)
    assert r.status_code==200,(r.status_code,'login failed');return c

def call(c,method,path,payload=None,status=200):
    r=c.request(method,a.base_url+'/api/v1/'+path,json=payload,timeout=60)
    assert r.status_code==status,(path,r.status_code,r.text[:400]);return r.json()
admin=login('r02a-admin');workers={u:login(u) for u in ['r02a-alice','r02a-bob','r02a-chai']}
dataset=call(admin,'POST','datasets',{'projectId':project,'name':'Synthetic tones','version':str(uuid.uuid4())},201)['dataset']['id']
assets=[]
for index in range(2):
    data=io.BytesIO()
    with wave.open(data,'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(8000)
        f.writeframes(b''.join(struct.pack('<h',int(2000*math.sin(2*math.pi*(220+index*110)*i/8000))) for i in range(64000)))
    r=admin.post(a.base_url+'/api/v1/assets',data={'datasetId':dataset,'originalPath':f'synthetic-{index}.wav'},files={'audio':(f'synthetic-{index}.wav',data.getvalue(),'audio/wav')},timeout=30)
    assert r.status_code==201,r.text[:300];assets.append(r.json()['asset'])
GRID='''File type = "ooTextFile"
Object class = "TextGrid"
xmin = 0
xmax = 8
tiers? <exists>
size = 1
item []:
item [1]:
class = "IntervalTier"
name = "Events"
xmin = 0
xmax = 8
intervals: size = 1
intervals [1]:
xmin = 0
xmax = 1
text = "prefill-only"
'''
records=[{'sample_id':f'tone-{i}','audio_id':asset['id'],'fields':{},'metadata':{'private':'R02A_PRIVATE_METADATA'},'items':[{'item_id':'listen','fields':{'prompt':{'type':'text','visibility':'worker','value':f'Events for tone {i}'},'alignment':{'type':'textgrid','visibility':'worker','value':GRID},'options':{'type':'choices','visibility':'worker','value':[{'id':'a','label':'Alpha'},{'id':'b','label':'Beta'}]}},'reference':{'field':'options','value':'a'}}]} for i,asset in enumerate(assets)]
call(admin,'POST',f'dataset-ingestion/import?projectId={project}&userId=r02a-admin',{'schema_version':1,'dataset_id':dataset,'source_version':'v1','provenance':{'origin':'synthetic','revision':'r02a'},'records':records})
items=call(admin,'GET',f'team-jobs?action=items&projectId={project}&datasetId={dataset}')['items']
block={'id':'ground','type':'timeline_annotation','label':'Grounding','required':False,'numBatch':2,'groundingMode':'sound','tiers':[{'id':'events','name':'Events','kind':'interval','labelMode':'text','allowOverlap':True}], 'sourceBindings':{'label':{'kind':'dataset','fieldId':'item.prompt','type':'string'},'value':{'kind':'dataset','fieldId':'item.alignment','type':'textgrid','mode':'prefill'}}}
draft={'name':'R02A Grounding','description':'Synthetic acceptance','domain':'sound','instructions':'Listen independently','policy':{'requiredIndependentVotes':3,'blindToOthers':True,'requiresReview':False},'blocks':[block,{'id':'category','type':'single_choice','label':'Category','required':True,'options':[{'id':'a','label':'Alpha'},{'id':'b','label':'Beta'}]}]}
definition=call(admin,'POST','task-definitions',{'projectId':project,'draft':draft},201)['taskDefinition']
call(admin,'POST',f'task-definitions/{definition["id"]}/publish',{'expectedRevision':1,'expectedPublishedVersion':0},201)
job={'jobId':str(uuid.uuid4()),'projectId':project,'name':'R02A independent grounding','datasetId':dataset,'definitionId':definition['id'],'definitionVersion':1,'mode':'voting','seed':'r02a','sampleCount':2,'itemKeys':[i['key'] for i in items],'workerIds':list(workers)}
plan=call(admin,'POST','team-jobs?action=preview',job)['plan'];launched=call(admin,'POST','team-jobs?action=launch',{**plan['input'],'expectedHash':plan['hash']})
resultpath=f'team-jobs?action=results&projectId={project}&jobId={job["jobId"]}'
assert call(admin,'GET',resultpath)['complete'] is False
call(next(iter(workers.values())),'GET',resultpath,status=403)
request=requests.get(a.base_url+'/api/v1/'+resultpath,timeout=15);assert request.status_code==401
submitted={}
for index,(user,c) in enumerate(workers.items()):
    assignment=next(x for x in launched['assignments'] if x['userId']==user)
    task=call(c,'GET','assignments/'+assignment['id'])['taskInstance']
    assert 'R02A_PRIVATE_METADATA' not in json.dumps(task)
    assert task['resolvedDefinition']['blocks'][0]['batchBlocks'][0]['label'].startswith('Events for tone')
    assert task['initialAnswers']['ground'][0]['tiers']['events'][0]['text']=='prefill-only'
    def timeline(intervals):return {'tiers':{'events':[{'id':f'e-{i}','start':s,'end':e,'text':'tone'} for i,(s,e) in enumerate(intervals)]}}
    ground=[timeline([[(1,3),(3,5)],[(1,5)],[(3,7)]][index]),timeline([] if index<2 else [(2,4)])]
    answer={'ground':ground,'category':'a' if index<2 else 'b'};submitted[user]=answer
    call(c,'POST',f'assignments/{assignment["id"]}/annotation/draft',{'labellerId':user,'expectedRevision':0,'answers':{'ground':task['initialAnswers']['ground']}},201)
    call(c,'POST',f'assignments/{assignment["id"]}/annotation/submit',{'labellerId':user,'expectedRevision':1,'answers':answer},201)
    assert call(c,'GET',f'assignments/{assignment["id"]}/annotation?labellerId={user}')['current']['answers']==answer
    if index<2:assert call(admin,'GET',resultpath)['complete'] is False
results=call(admin,'GET',resultpath);assert results==call(admin,'GET',resultpath)
assert results['complete'] and results['uniqueAudioItems']==2 and results['workerSubmissions']==3
scopes=[i for i in results['items'] if i['block']['type']=='timeline_annotation'];assert len(scopes)==2
first,second=scopes;assert abs(first['mean']-5/9)<1e-12 and first['eligiblePairs']==3
assert second['mean']==0 and second['eligiblePairs']==2 and second['absencePairs']==1 and second['excludedPairs']==1
aggregate=next(b for b in results['blocks'] if b['blockId']=='ground');assert abs(aggregate['meanSimilarity']-1/3)<1e-12
assert aggregate['validComparisons']==5 and aggregate['validObservations']==6
assert next(b for b in results['blocks'] if b['blockId']=='category')['meanSimilarity']==1/3
export=call(admin,'GET',f'research-export?projectId={project}&jobId={job["jobId"]}&format=json')
assert export['analytics']==results
for annotation in export['tasks'][0]['annotations']:assert annotation['answers']==submitted[annotation['workerId']]
assert 'R02A_PRIVATE_METADATA' not in json.dumps(export)
for asset in assets:
    r=admin.get(a.base_url+f'/api/v1/assets/{asset["id"]}/audio',headers={'Range':'bytes=0-43'},timeout=15)
    assert r.status_code==206 and r.content[:4]==b'RIFF'
with sqlite3.connect(Path(fixture['database']).as_uri()+'?mode=ro',uri=True) as db:
    rows=db.execute("SELECT r.status,count(*) FROM annotation_revisions r JOIN annotation_job_assignments ja ON ja.assignment_id=r.assignment_id WHERE ja.job_id=? GROUP BY r.status",(job["jobId"],)).fetchall()
    assert dict(rows)=={'draft':3,'submitted':3};assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
(root/'R02A_RESULTS.json').write_text(json.dumps(results,indent=2))
(root/'R02A_ACCEPTANCE.json').write_text(json.dumps({'projectId':project,'jobId':job['jobId'],'definitionId':definition['id'],'revisions':dict(rows),'status':'PASS'},indent=2))
print('PASS real Worker/D1/R2: source-bound prefill, 2 audio slots, 3 workers, draft/final/reload, 5/9 and 0 item means, 1/3 pair-weighted job mean, empty pair exclusion, categorical 1/3, privacy/401/403, raw export equality and WAV ranges')
