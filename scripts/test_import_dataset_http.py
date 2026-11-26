#!/usr/bin/env python3
"""Real authenticated CLI imports against marked disposable localhost Worker/D1 only."""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid
import wave
from local_admin_api import LocalAdminAPI

p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state-root',required=True);p.add_argument('--base-url',default='http://127.0.0.1:5175');args=p.parse_args()
state=Path(args.state_root).resolve();repo=Path(__file__).resolve().parents[1]
assert (state/'DISPOSABLE_DEMO.json').is_file() and (state/'TEAM_DEMO.json').is_file()
fixture=json.loads((state/'TEAM_DEMO.json').read_text());project=fixture['projectId'];credentials=state/'demo-login.txt'
grid='''File type = "ooTextFile"
Object class = "TextGrid"
xmin = 0
xmax = 1
tiers? <exists>
size = 1
item []:
item [1]:
class = "IntervalTier"
name = "words"
xmin = 0
xmax = 1
intervals: size = 1
intervals [1]:
xmin = 0
xmax = 1
text = "hello"
'''
def checked(response):
    assert response.status_code in (200,201), (response.status_code,response.text[:300])
    return response.json()
with tempfile.TemporaryDirectory(prefix='audiolab-cli-auth-http-') as directory, LocalAdminAPI(args.base_url,'demo-admin',credentials) as api:
    root=Path(directory)
    assert any(row['id']==project for row in checked(api.request('GET','/api/v1/projects'))['projects']), 'Server does not expose the marked disposable fixture project'
    with wave.open(str(root/'sample.wav'),'wb') as wav:
        wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(b'\0\0'*16000)
    (root/'sample.TextGrid').write_text(grid)
    for adapter in ['paired-textgrid','canonical']:
        dataset=checked(api.request('POST','/api/v1/datasets',json={'projectId':project,'name':'CLI auth regression '+adapter+' '+uuid.uuid4().hex[:8],'version':'1'}))['dataset']['id']
        output=root/adapter
        command=[sys.executable,str(repo/'scripts/import_dataset.py'),'--base-url',args.base_url,'--project-id',project,'--dataset-id',dataset,'--adapter',adapter,'--root',str(root),'--username','demo-admin','--credentials-file',str(credentials),'--annotation-visibility','worker','--output',str(output)]
        if adapter=='canonical':
            manifest=root/'canonical.json'
            manifest.write_text(json.dumps({'schema_version':1,'dataset_id':dataset,'source_version':'v1','provenance':{'origin':'test','revision':'1'},'records':[{'sample_id':'sample','audio_id':str(uuid.uuid4()),'metadata':{'originalPath':'sample.wav'},'items':[{'item_id':'question','fields':{'question':{'type':'text','value':'Is the target present?','visibility':'worker'}}}]}]}))
            command.extend(['--manifest',str(manifest)])
        def run(extra,expect=0,input=None):
            result=subprocess.run(command+extra,input=input,text=True,capture_output=True,cwd=repo)
            assert result.returncode==expect, result.stderr[:1200]
            return result
        run(['--dry-run'])
        assert checked(api.request('GET','/api/v1/assets',params={'datasetId':dataset}))['assets']==[]
        assert json.loads((output/'report.json').read_text())['completedBatches']==[]
        if adapter=='canonical':
            # Named dataset registration is explicit and rewrites only the
            # generated envelope, not the user's canonical manifest file.
            name='CLI named import '+uuid.uuid4().hex[:8]
            position=command.index('--dataset-id');command[position:position+2]=['--create-dataset',name,'--dataset-version','v1']
        run(['--import'])
        if adapter=='canonical':
            dataset=next(row['id'] for row in checked(api.request('GET','/api/v1/datasets',params={'projectId':project}))['datasets'] if row['name']==name)
        first=checked(api.request('GET','/api/v1/assets',params={'datasetId':dataset}))['assets'];assert len(first)==1
        run(['--import'])
        second=checked(api.request('GET','/api/v1/assets',params={'datasetId':dataset}))['assets'];assert [row['id'] for row in first]==[row['id'] for row in second]
        report=json.loads((output/'report.json').read_text());assert report['existingAudio']==1 and report['missingAudio']==0
        records=checked(api.request('GET','/api/v1/source-records',params={'assetId':first[0]['id']}))['sourceRecords'];assert len(records)==1
        source=checked(api.request('GET','/api/v1/source-fields',params={'projectId':project,'datasetId':dataset,'assetId':first[0]['id'],'recordId':records[0]['sourceRecordId'],'userId':api.user_id,'view':'admin'}))['source']
        assert any(field['field']['id']==('item.alignment' if adapter=='paired-textgrid' else 'item.question') for field in source['fields'])
        if adapter=='paired-textgrid':
            # Real wizard path with no manual UUID entry; catalog selections supplied over stdin.
            projects=checked(api.request('GET','/api/v1/projects'))['projects'];allowed={m['projectId'] for m in api.memberships if m['role']=='admin'}
            visible=[row for row in projects if row['id'] in allowed];project_number=next(i+1 for i,row in enumerate(visible) if row['id']==project)
            datasets=checked(api.request('GET','/api/v1/datasets',params={'projectId':project}))['datasets'];dataset_number=next(i+1 for i,row in enumerate(datasets) if row['id']==dataset)
            wizard=[sys.executable,str(repo/'scripts/import_dataset.py'),'--base-url',args.base_url,'--interactive','--username','demo-admin','--credentials-file',str(credentials),'--output',str(root/'wizard')]
            result=subprocess.run(wizard,input=f'{project_number}\n{dataset_number}\n1\n{root}\ny\n',text=True,capture_output=True,cwd=repo)
            assert result.returncode==0,result.stderr[:1000]
            assert 'DRY RUN' in result.stdout
        # Borrowed cookie imports do not revoke the caller's existing session.
        jarfile=root/'cookies.txt';jar=http.cookiejar.MozillaCookieJar(str(jarfile))
        for cookie in api.session.cookies:jar.set_cookie(cookie)
        jar.save(ignore_discard=True);os.chmod(jarfile,0o600)
        borrowed=[value for value in command]
        index=borrowed.index('--credentials-file');borrowed[index:index+2]=['--cookie-file',str(jarfile)]
        if '--create-dataset' in borrowed:
            index=borrowed.index('--create-dataset');borrowed[index:index+2]=['--dataset-id',dataset]
            # Generated batch has materialized the chosen dataset/audio IDs.
            index=borrowed.index('--manifest');borrowed[index+1]=str(output/'batch-0001.json')
        result=subprocess.run(borrowed+['--dry-run'],text=True,capture_output=True,cwd=repo);assert result.returncode==0,result.stderr[:1000]
        assert checked(api.request('GET','/api/v1/auth/session'))['user']['userId']=='demo-admin'
        # Actor spoofing and worker imports fail before uploads/persistence.
        run(['--import','--user-id','demo-bob'],expect=1)
        worker=list(command);worker[worker.index('demo-admin')]='demo-alice'
        denied=subprocess.run(worker+['--import'],text=True,capture_output=True,cwd=repo);assert denied.returncode==1 and 'not an admin' in denied.stderr
print('PASS actual authenticated CLI/Worker/D1: paired TextGrid + canonical question WAV upload, dry-run without dataset writes, identical reimport/audio reuse, numbered wizard, borrowed cookies retained, spoof/worker denial. Labelled regression datasets in marked disposable state only; no migrations or preserved/remote D1.')
