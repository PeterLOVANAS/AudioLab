#!/usr/bin/env python3
"""Real Vinext/D1/R2 integration test for v4. No mocks or pip packages.

This script creates a NEW immutable Task Definition, a new multi-WAV Task
Instance, one curated candidate, and a DEV-only assignment. It does NOT edit
an existing annotation, delete DB rows, or reveal MMAU source_labels.

Prerequisites: migration 0008 applied to the REVIEW .cloudflare/state and
at least 8 real WAV assets in one dataset (imported with import_mmau.py).

Usage: python3 -u scripts/test_v4_http.py PROJECT_UUID DATASET_UUID [http://localhost:5173]
"""
import json,sys,uuid
from urllib.request import Request,urlopen
from urllib.error import HTTPError

if len(sys.argv)<3:
    sys.exit('Usage: python3 scripts/test_v4_http.py PROJECT_UUID DATASET_UUID [BASE_URL]')
PROJECT,DATASET=sys.argv[1:3];BASE=(sys.argv[3] if len(sys.argv)>3 else 'http://localhost:5173').rstrip('/')

def api(method,path,data=None,expected=200):
    req=Request(BASE+path,data=json.dumps(data).encode() if data is not None else None,
        method=method,headers={'Content-Type':'application/json'} if data is not None else {})
    try:r=urlopen(req,timeout=35)
    except HTTPError as exc:r=exc
    with r:
        text=r.read().decode('utf-8','replace')
        try:value=json.loads(text)
        except ValueError:value={'notJson':text[:300]}
        assert r.status==expected,'HTTP {} {} expected {}: {}'.format(method,path,expected,value)
        return value

assets=api('GET','/api/v1/assets?datasetId='+DATASET)['assets']
if len(assets)<8:sys.exit('Need >= 8 MMAU audio assets; found {}'.format(len(assets)))
ids=[a['id'] for a in assets[:8]];print('[1/8] 8 real audio assets found',flush=True)
uid=uuid.uuid4().hex[:7]
comparison={'id':'comparison','type':'audio_comparison','label':'Which audio is clearer?',
    'required':True,'numBatch':8,'comparisonSize':2,'stimulusSlots':['Audio A','Audio B'],
    'options':[{'id':'A','label':'Recording A'},{'id':'B','label':'Recording B'}]}
presence={'id':'presence','type':'single_choice','required':True,'label':'Bird present?',
    'options':[{'id':'present','label':'Present'},{'id':'absent','label':'Absent'}],
    'optionFollowUps':{'absent':[{'id':'confirmed','type':'boolean','label':'Heard entire clip',
          'required':True,'requiredValue':True}]}}
vote={'id':'vote','type':'candidate_vote','label':'Verify model annotation',
    'required':True,'candidateSource':'curated',
    'options':[{'id':'yes','label':'Agree'},{'id':'no','label':'Disagree'}]}
ranking={'id':'rank','type':'ranking','label':'Rank properties','required':True,
    'rankingMode':'labels','rankingInput':'arrows',
    'rankLabels':[{'id':'clarity','label':'Clarity'},{'id':'natural','label':'Naturalness'}]}
text={'id':'caption','type':'text','label':'Describe each audio','required':True,'numBatch':8}
draft={'name':'v4 integration '+uid,'description':'Generated integration test',
    'domain':'sound','instructions':'Listen to all eight recordings.',
    'blocks':[presence,comparison,ranking,vote,text],
    'policy':{'requiredIndependentVotes':1,'blindToOthers':True,'requiresReview':False}}
created=api('POST','/api/v1/task-definitions',{'projectId':PROJECT,'draft':draft},201)['taskDefinition']
id=created['id']
api('POST','/api/v1/task-definitions/'+id+'/publish',{
    'expectedRevision':created['draftRevision'],
    'expectedPublishedVersion':created['publishedVersion']},201)
print('[2/8] Saved/published v4 definition',id,flush=True)
candidate=api('POST','/api/v1/annotation-candidates',{'projectId':PROJECT,'assetId':ids[0],
    'label':'Proposed audible bird call (QA candidate — NOT ground truth)',
    'provenance':'model'},201)['candidate']
print('[3/8] Stored curated candidate separately from MMAU reference answer',flush=True)
instance=api('POST','/api/v1/task-instances',{'projectId':PROJECT,
    'definitionId':id,'definitionVersion':1,'assetId':ids[0],
    'audioAssetIds':ids},201)['taskInstance']
instance_id=instance['id'];assert [a['id'] for a in instance['audioAssets']]==ids
assert any(c['id']==candidate['id'] for c in instance['candidates'])
assert 'referenceAnswer' not in json.dumps(instance)
print('[4/8] Persisted eight ordered WAV links without leaking reference labels',flush=True)
labeller='v4-test-'+uid
api('POST','/api/v1/project-members',{'projectId':PROJECT,'userId':labeller,
    'displayName':labeller,'role':'labeller'},201)
assignment=api('POST','/api/v1/assignments',{'projectId':PROJECT,
    'taskInstanceId':instance_id,'labellerId':labeller},201)['assignment']
print('[5/8] Created assignment',flush=True)
url='/api/v1/assignments/'+assignment['id']+'/annotation/submit'
answers={'presence':{'selection':'absent','children':{'confirmed':True}},
    'comparison':['A','B','A','B'],'rank':['natural','clarity'],
    'vote':{'value':'yes','candidateId':candidate['id']},
    'caption':['caption '+str(n) for n in range(8)]}
invalid={**answers,'vote':{'value':'yes','candidateId':str(uuid.uuid4())}}
api('POST',url,{'labellerId':labeller,'expectedRevision':0,'answers':invalid},422)
print('[6/8] Unknown candidate rejected (422)',flush=True)
invalid2={**answers,'presence':{'selection':'absent','children':{'confirmed':False}}}
api('POST',url,{'labellerId':labeller,'expectedRevision':0,'answers':invalid2},422)
print('[7/8] False required inline confirmation rejected (422)',flush=True)
result=api('POST',url,{'labellerId':labeller,'expectedRevision':0,'answers':answers},201)
assert result['annotation']['status']=='submitted'
print('[8/8] Batch + comparison + ranking + candidate + inline condition submitted',flush=True)
print('PASS: v4 HTTP integration',flush=True)
