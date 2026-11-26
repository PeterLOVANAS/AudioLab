#!/usr/bin/env python3
"""R01B real CLI and fault-injected transport tests on init_local-managed TEMP state.

No fake HTTP responses or app failpoints. Interruptions are injected in the test
client before/after real requests; SQLite reads independently verify committed
state. The directory must have been newly provisioned by init_local.py.
"""
from __future__ import annotations
import argparse
import contextlib
import copy
import io
import http.cookiejar
import os
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from unittest.mock import patch
import uuid
import requests
import import_dataset as cli
from local_admin_api import LocalAdminAPI
from import_labellers import find_database

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--state-root',type=Path,required=True)
p.add_argument('--base-url',default='http://127.0.0.1:5197')
a=p.parse_args();root=a.state_root.resolve();repo=Path(__file__).resolve().parents[1]
assert Path(tempfile.gettempdir()).resolve() in root.parents and repo not in root.parents
setup=json.loads((root/'environment.json').read_text());assert setup['kind']=='audiolab.local-environment/1' and setup['status']=='ready'
project=setup['projectId'];credentials=root/'admin-credentials.json';database=find_database(root)
output=root/'ingestion-tests'/uuid.uuid4().hex;output.mkdir(parents=True,mode=0o700)
cookie_file=output/'session.cookies'
example=repo/'examples/datasets/synthetic';template=json.loads((example/'manifest.json').read_text())
original_request=LocalAdminAPI.request

def command(name,manifest=None):
    return ['--base-url',a.base_url,'--project-id',project,'--create-dataset',name,'--dataset-version','v1',
            '--adapter','canonical','--manifest',str(manifest or example/'manifest.json'),'--root',str(example/'audio'),
            '--cookie-file',str(cookie_file),'--output',str(output/name),'--import']

def subprocess_cli(arguments,success=True):
    result=subprocess.run([sys.executable,str(repo/'scripts/import_dataset.py'),*arguments],text=True,capture_output=True,cwd=repo)
    assert (result.returncode==0)==success,(result.returncode,result.stderr[:1000])
    assert json.loads(credentials.read_text())['accounts'][0]['password'] not in result.stdout+result.stderr
    return result


def datasets(api):return cli.checked(api.request('GET','/api/v1/datasets',params={'projectId':project}))['datasets']

def asset_rows(api,dataset):return cli.checked(api.request('GET','/api/v1/assets',params={'datasetId':dataset}))['assets']

def counts(dataset):
    with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True) as db:
        return (db.execute('SELECT count(*) FROM audio_assets WHERE dataset_id=?',(dataset,)).fetchone()[0],
                db.execute('SELECT count(*) FROM source_records WHERE canonical_dataset_id=?',(dataset,)).fetchone()[0])


def invoke_fault(arguments,stage):
    calls={'imports':0};fired=False
    def request(client,method,path,**kwargs):
        nonlocal fired
        if path=='/api/v1/dataset-ingestion/import' and method=='POST':
            calls['imports']+=1
            if stage=='between-batches' and calls['imports']==2:
                fired=True;raise requests.ConnectionError('Injected interruption before metadata batch two')
        response=original_request(client,method,path,**kwargs)
        if not fired and method=='POST' and ((stage=='dataset-created' and path=='/api/v1/datasets') or
                                            (stage=='audio-uploaded' and path=='/api/v1/assets') or
                                            (stage=='metadata-committed' and path=='/api/v1/dataset-ingestion/import')):
            if response.status_code in (200,201):
                fired=True;raise requests.ConnectionError('Injected lost response after committed '+stage)
        return response
    with patch.object(LocalAdminAPI,'request',request),patch.object(sys,'argv',['import_dataset.py',*arguments]),contextlib.redirect_stdout(io.StringIO()):
        try:cli.main()
        except requests.ConnectionError:pass
        else:raise AssertionError('Expected injected transport interruption')
    assert fired


def stale_inventory(arguments,mismatch=False):
    """Simulate a real concurrent uploader between inventory and upload (409).

    The inventory response is a genuine earlier snapshot, not a fake endpoint.
    Existing bytes must be verified even if another importer wins the upload race.
    """
    fired=False
    def request(client,method,path,**kwargs):
        nonlocal fired
        response=original_request(client,method,path,**kwargs)
        if not fired and method=='GET' and path=='/api/v1/assets' and response.json()['assets']==[]:
            fired=True
            file=example/'audio'/('pulsed-tone.wav' if mismatch else 'steady-tone.wav')
            with file.open('rb') as handle:
                uploaded=original_request(client,'POST','/api/v1/assets',data={'datasetId':kwargs['params']['datasetId'],'originalPath':'steady-tone.wav'},files={'audio':('steady-tone.wav',handle,'audio/wav')})
                assert uploaded.status_code==201
        return response
    with patch.object(LocalAdminAPI,'request',request),patch.object(sys,'argv',['import_dataset.py',*arguments]),contextlib.redirect_stdout(io.StringIO()):
        if mismatch:
            try:cli.main()
            except ValueError as error:assert 'different bytes' in str(error)
            else:raise AssertionError('A concurrent different-byte asset must be rejected')
        else:cli.main()
    assert fired


with LocalAdminAPI(a.base_url,credentials_file=credentials) as api:
    jar=http.cookiejar.MozillaCookieJar(str(cookie_file))
    for cookie in api.session.cookies:jar.set_cookie(cookie)
    jar.save(ignore_discard=True);os.chmod(cookie_file,0o600)
    # Borrow one session for the batch; do not disable or exhaust the login limiter.
    # Bootstrap identity is discovered, not demo-admin or a hardcoded project.
    assert api.user_id==setup['userId'];api.require_admin(project)
    name='canonical-'+uuid.uuid4().hex[:8];arguments=command(name)
    subprocess_cli(arguments)
    target=next(d for d in datasets(api) if d['name']==name)['id']
    assert counts(target)==(2,2)
    first=asset_rows(api,target);assert all(abs(row['durationSeconds']-4)<1e-12 for row in first)
    report=json.loads((output/name/'report.json').read_text());assert report['status']=='complete' and len(report['acceptedItems'])==2
    # Default/dry-run is schema + server validation with no domain writes.
    dry=list(arguments);dry.remove('--import');idx=dry.index('--create-dataset');dry[idx:idx+2]=['--dataset-id',target,'--retarget-dataset']
    subprocess_cli(dry+['--dry-run']);assert counts(target)==(2,2)
    assert json.loads((output/name/'report.json').read_text())['backendValidation']=='passed'
    subprocess_cli(arguments);assert counts(target)==(2,2)
    assert [row['id'] for row in first]==[row['id'] for row in asset_rows(api,target)]
    assert len(list((output/name/'attempts').glob('*.json')))==3
    accepted=json.loads((output/name/'report.json').read_text())['acceptedItems'][0]
    inspect=['--base-url',a.base_url,'--project-id',project,'--dataset-id',target,'--cookie-file',str(cookie_file),
             '--inspect','--record-id',accepted['source_record_id'],'--audio-id',accepted['audio_id'],'--output',str(output/'inspection')]
    subprocess_cli(inspect)
    data=json.loads((output/'inspection/inspection.json').read_text())
    assert data['item']['schema_version']==1 and data['labels']
    assert (output/'inspection/inspection.json').stat().st_mode&0o777==0o600
    spoof=api.request('POST','/api/v1/dataset-ingestion/import',params={'projectId':project,'userId':'not-the-session-user'},json=template)
    assert spoof.status_code==403
    anonymous=requests.post(a.base_url+'/api/v1/dataset-ingestion/validate',json=template,timeout=10);assert anonymous.status_code==401
    # A genuine immutable-source conflict must fail without changing prior data.
    changed=copy.deepcopy(template);changed['records'][0]['items'][0]['fields']['prompt']['value']='Changed source text'
    changed_file=output/'changed.json';changed_file.write_text(json.dumps(changed))
    conflict=list(arguments);conflict[conflict.index('--manifest')+1]=str(changed_file)
    subprocess_cli(conflict,False);assert counts(target)==(2,2)
    assert json.loads((output/name/'report.json').read_text())['status']=='failed'
    # Failure injection verifies actual committed partial state and replay, not mocks.
    evidence=[]
    for stage,expected_counts in [('dataset-created',(0,0)),('audio-uploaded',(1,0)),('between-batches',(2,20)),('metadata-committed',(2,20))]:
        name=stage+'-'+uuid.uuid4().hex[:8]
        manifest=copy.deepcopy(template)
        manifest['records']=[{**copy.deepcopy(template['records'][i%2]),'sample_id':f'item-{i:02}'} for i in range(23)]
        source=output/(name+'.json');source.write_text(json.dumps(manifest))
        args=command(name,source);invoke_fault(args,stage)
        target=next(d for d in datasets(api) if d['name']==name)['id']
        assert counts(target)==expected_counts,(stage,counts(target))
        report=json.loads((output/name/'report.json').read_text())
        assert report['status']=='failed' and report['remoteStateMayHaveChanged']
        if stage=='dataset-created':assert report['datasetId'] is None and report['datasetName']==name
        if stage=='audio-uploaded':assert report['pendingAudioPath'] and report['uploadedAudio']==[]
        if stage=='between-batches':assert report['completedBatches']==[1] and report['pendingBatch']==2
        if stage=='metadata-committed':assert report['completedBatches']==[] and report['pendingBatch']==1
        subprocess_cli(args);assert counts(target)==(2,23)
        retried=json.loads((output/name/'report.json').read_text());assert retried['completedBatches']==[1,2] and retried['status']=='complete'
        subprocess_cli(args);assert counts(target)==(2,23)
        evidence.append({'stage':stage,'afterFailure':expected_counts,'afterRetry':[2,23],'status':'PASS'})
    for mismatch in [False,True]:
        name='concurrent-'+str(mismatch).lower()+'-'+uuid.uuid4().hex[:8]
        stale_inventory(command(name),mismatch)
        target=next(d for d in datasets(api) if d['name']==name)['id']
        assert counts(target)==((1,0) if mismatch else (2,2))
        if mismatch:assert json.loads((output/name/'report.json').read_text())['status']=='failed'
    # Existing paired-folder and MMAU adapters use the same authenticated path.
    import shutil
    paired=output/'paired';paired.mkdir();shutil.copyfile(example/'audio/steady-tone.wav',paired/'tone.wav')
    (paired/'tone.TextGrid').write_text(template['records'][0]['items'][0]['fields']['alignment']['value'])
    mmau=output/'mmau.json';mmau.write_text(json.dumps([{'id':'mmau-example','audio_id':'steady-tone.wav','question':'Tone kind?', 'choices':['Steady','Pulsed'],'answer':'Steady'}]))
    for adapter,folder,manifest in [('paired-textgrid',paired,None),('mmau',example/'audio',mmau)]:
        name=adapter+'-'+uuid.uuid4().hex[:8]
        args=['--base-url',a.base_url,'--project-id',project,'--create-dataset',name,'--adapter',adapter,'--root',str(folder),'--cookie-file',str(cookie_file),'--output',str(output/name),'--import']
        if manifest:args.extend(['--manifest',str(manifest)])
        subprocess_cli(args);target=next(d for d in datasets(api) if d['name']==name)['id'];assert counts(target)==(1,1)
        subprocess_cli(args);assert counts(target)==(1,1)
    with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True) as db:
        assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
        assert db.execute('SELECT count(*) FROM auth_identity_links').fetchone()[0]==0
    (output/'acceptance.json').write_text(json.dumps({'projectId':project,'failures':evidence,'status':'PASS'},indent=2))
print('Acceptance evidence:',output/'acceptance.json')
print('PASS fresh Worker/D1/R2: generated admin, canonical v1/classification/TextGrid, local CLI validation/import/inspect/retry, stable assets/duration, 401/403/conflicts, paired/MMAU compatibility, 4 real partial-write/retry cases; no copied/remote data')
