#!/usr/bin/env python3
"""Live HTTP smoke test: candidate-vote customization + Sound timeline block.

Usage:
    python3 scripts/test_candidate_sound_http.py PROJECT_ID DATASET_ID [BASE_URL]

Requires a running, local Vinext + migrated D1/R2 review database with >=1
imported WAV. Creates its own scratch definition, instance, member, assignment
and annotation; NEVER use against a shared deployment. No source labels read.
"""
import json, sys, uuid
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError


def send(method, path, data=None):
    req=Request(BASE+path, method=method,
                data=json.dumps(data).encode() if data is not None else None,
                headers={'Content-Type':'application/json'} if data is not None else {})
    try:
        response=urlopen(req,timeout=20)
    except HTTPError as err:
        response=err
    with response:
        payload=response.read()
        return response.status,json.loads(payload.decode() or '{}')


def ok(code, method, path, data=None):
    got, body=send(method,path,data)
    assert got==code, f'{method} {path}: expected {code}, got {got}: {body}'
    return body


if __name__=='__main__':
    if len(sys.argv)<3:
        sys.exit('Usage: python3 test_candidate_sound_http.py PROJECT_ID DATASET_ID [BASE_URL]')
    PROJECT,DATASET=sys.argv[1:3]
    BASE=(sys.argv[3] if len(sys.argv)>3 else 'http://localhost:5173').rstrip('/')
    name='v3-'+uuid.uuid4().hex[:10]
    assets=ok(200,'GET','/api/v1/assets?'+urlencode({'datasetId':DATASET}))['assets']
    assert assets, 'MMAU WAV required in the isolated review R2 state'
    definition={
      'name':'Prototype parity smoke '+name,'description':'Candidate + sound mode',
      'domain':'sound','instructions':'Listen and annotate one sound region.',
      'policy':{'requiredIndependentVotes':1,'blindToOthers':True,'requiresReview':False},
      'blocks':[
        {'id':'sound','type':'timeline_annotation','label':'Sound workbench',
         'required':True,'groundingMode':'sound','precisionSeconds':0.01,
         'laneLayout':'overlap','aids':{'spectrogram':True,'pitch':False,'mfcc':False},
         'tiers':[{'id':'events','name':'Sound events','kind':'interval','allowOverlap':True,'labelMode':'text'}]},
        {'id':'vote','type':'candidate_vote','label':'Candidate evaluation','required':True,
         'candidatePrompt':'Evaluate the candidate sound class',
         'options':[{'id':'AGREE','label':'Correct'},
                    {'id':'DISAGREE','label':'Needs correction'},
                    {'id':'UNSURE','label':'Uncertain'}],
         'allowCorrection':True,'correctionOnValue':'DISAGREE'},
      ]}
    row=ok(201,'POST','/api/v1/task-definitions',{'projectId':PROJECT,'draft':definition})['taskDefinition']
    did=row['id']
    ok(201,'POST',f'/api/v1/task-definitions/{did}/publish',
       {'expectedRevision':row['draftRevision'],'expectedPublishedVersion':row['publishedVersion']})
    published=ok(200,'GET',f'/api/v1/task-definitions/{did}/versions/1')['published']['definition']
    assert published['blocks'][0]['groundingMode']=='sound'
    assert published['blocks'][1]['options'][1]['label']=='Needs correction'
    job=ok(201,'POST','/api/v1/task-instances',{'projectId':PROJECT,
        'definitionId':did,'definitionVersion':1,'assetId':assets[0]['id']})['taskInstance']
    ok(201,'POST','/api/v1/project-members',{'projectId':PROJECT,'userId':name,'displayName':name,'role':'labeller'})
    assignment=ok(201,'POST','/api/v1/assignments',{'projectId':PROJECT,
        'taskInstanceId':job['id'],'labellerId':name})['assignment']['id']
    endpoint=f'/api/v1/assignments/{assignment}/annotation/submit'
    audio={'tiers':{'events':[{'id':'evt1','start':0.1,'end':0.3,'text':'Bird chirp'}]}}
    body={'labellerId':name,'expectedRevision':0,'answers':{'sound':audio,'vote':{'value':'DISAGREE'}}}
    bad=ok(422,'POST',endpoint,body)
    assert bad.get('issues'),bad
    body['answers']['vote']['correctedText']='Another event class'
    valid=ok(201,'POST',endpoint,body)['annotation']
    assert valid['status']=='submitted'
    print('PASS: candidate vote options + Sound grounding saved, published, and submitted via D1.')
