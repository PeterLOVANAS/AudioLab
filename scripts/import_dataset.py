#!/usr/bin/env python3
"""Canonical AudioLab dataset planner/importer (local or explicit HTTPS Access).

Default is dry-run: scan/convert files and write canonical JSON; never write D1.
Adapters: paired-textgrid (no manifest), mmau (legacy JSON/JSONL), canonical.
Use --import only to explicitly upload missing WAVs and persist source metadata.
Existing audio paths are reused. Every metadata batch passes the backend validator.
"""
from __future__ import annotations
import argparse
import os
import tempfile
import base64
import hashlib
import json
import re
import sys
import subprocess
import uuid
import wave
from pathlib import Path
from urllib.parse import urlparse
import requests
sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_admin_api import LocalAdminAPI

MAX_PAYLOAD = 250 * 1024  # headroom below the backend's 256 KiB boundary
MAX_AUDIO = 10 * 1024 * 1024


def private_json(path, value, compact=False):
    """Write source-bearing output atomically with private file permissions."""
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as handle:
        json.dump(value,handle,ensure_ascii=False,indent=None if compact else 2,separators=(',',':') if compact else None)
    os.replace(temporary,path)


def save_progress(args, **changes):
    """A per-attempt journal reports acknowledged commits and ambiguous requests.

    A network failure may occur after a remote commit. Never call the whole import
    atomic or infer that an unacknowledged write did not persist. Replays validate
    immutable source hashes and original-path asset identity on the server.
    """
    args.progress.update(changes)
    args.output.mkdir(parents=True,exist_ok=True,mode=0o700)
    history=args.output/'attempts';history.mkdir(exist_ok=True,mode=0o700)
    private_json(history/(args.progress['attemptId']+'.json'),args.progress)
    private_json(args.output/'report.json',args.progress)


def inspect_audio(file):
    """Validate the CLI's uncompressed PCM WAV subset and compute duration.

    Python wave support is intentionally narrower than the upload endpoint's
    RIFF tag recognition. Float/compressed files require explicit conversion;
    no decoder/transcoder or path guessing is added to canonical schema v1.
    """
    if file.suffix.lower()!='.wav' or not 0<file.stat().st_size<=MAX_AUDIO:
        raise ValueError(f'{file.name}: expected a nonempty WAV of at most 10 MiB')
    try:
        with wave.open(str(file),'rb') as wav:
            if wav.getcomptype()!='NONE' or wav.getnframes()<=0 or wav.getframerate()<=0:
                raise ValueError('Invalid PCM WAV frame count/rate')
            duration=wav.getnframes()/wav.getframerate()
            # wave can read a declared frame count from a truncated data chunk.
            remaining=wav.getnframes()*wav.getnchannels()*wav.getsampwidth()
            while remaining:
                chunk=wav.readframes(min(wav.getnframes(),65536))
                if not chunk:raise ValueError('Truncated WAV audio frames')
                remaining-=len(chunk)
            return duration
    except (wave.Error,EOFError) as error:
        raise ValueError(f'{file.name}: use uncompressed PCM WAV; {error}') from error

def safe_id(value: str) -> str:
    """Keep portable external IDs; otherwise retain original in metadata and hash identity."""
    return value if re.fullmatch(r'[A-Za-z0-9_.-]{1,60}', value) else 'sample-' + hashlib.sha256(value.encode()).hexdigest()[:32]

def strict_json(path: Path):
    """Reject duplicate keys/nonfinite numbers instead of silently changing source data."""
    def object_pairs(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                raise ValueError(f'Duplicate JSON key: {key}')
            out[key] = value
        return out
    return json.loads(path.read_text(encoding='utf-8-sig'), object_pairs_hook=object_pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON number')))

def source_file(path: Path, visibility: str) -> dict:
    """Store original file bytes as well as decoded source text; do not regenerate Praat files."""
    raw = path.read_bytes()
    if not raw or len(raw) > 100_000:
        raise ValueError(f'{path.name}: TextGrid must be 1–100000 bytes for bounded inline ingestion')
    encoding = 'utf-16le' if raw.startswith(b'\xff\xfe') else 'utf-16be' if raw.startswith(b'\xfe\xff') else 'utf-8'
    text = raw.decode(encoding, errors='strict').lstrip('\ufeff')
    if 'TextGrid' not in text[:200]:
        raise ValueError(f'{path.name}: not a text Praat TextGrid')
    return {'type':'textgrid','visibility':visibility,'value':text,
            'file':{'name':path.name,'media_type':'text/praat-textgrid','encoding':encoding,
                    'sha256':hashlib.sha256(raw).hexdigest(), 'content_base64':base64.b64encode(raw).decode('ascii')}}

def plan_paired(root: Path, dataset: str, existing: dict, visibility: str, require_grid: bool = False):
    """Exact same-folder/stem pairing; ambiguous sidecars and symlink escapes are errors."""
    root=root.expanduser().resolve()
    records, assets, skipped = [], {}, []
    for audio in sorted(root.rglob('*')):
        if audio.suffix.lower() != '.wav' or not audio.is_file():
            continue
        relative = audio.resolve().relative_to(root).as_posix()
        grids = sorted(p for p in audio.parent.iterdir() if p.is_file() and p.stem == audio.stem and p.suffix.lower() == '.textgrid')
        if len(grids) != 1:
            if grids or require_grid:
                raise ValueError(f'{relative}: expected exactly one matching TextGrid, found {len(grids)}')
            skipped.append({'audio':relative,'reason':'No same-folder/stem TextGrid'})
            continue
        grids[0].resolve().relative_to(root)
        duration=inspect_audio(audio)
        asset_id = existing.get(relative) or str(uuid.uuid5(uuid.UUID(dataset), relative))
        assets[relative] = {'audio_id':asset_id,'registered':relative in existing,'file':audio,'duration_seconds':duration}
        records.append({'sample_id':safe_id(relative),'audio_id':asset_id,
                        'metadata':{'originalPath':relative,'durationSeconds':duration},
                        'items':[{'item_id':'annotation','fields':{'alignment':source_file(grids[0],visibility)}}]})
    if not records:
        raise ValueError('No valid WAV/TextGrid pairs found')
    return records, assets, skipped

def batches(envelope: dict, records: list):
    """Bound by sample count, item count and actual UTF-8 JSON size, not just file count."""
    current = []
    for record in records:
        candidate = current + [record]
        payload = {**envelope,'records':candidate}
        if len(candidate)>20 or sum(len(r['items']) for r in candidate)>50 or len(json.dumps(payload,ensure_ascii=False).encode())>MAX_PAYLOAD:
            if not current:
                raise ValueError('One sample exceeds canonical batch limits; split its items/source artifact')
            yield {**envelope,'records':current}
            current = [record]
            if len(record['items'])>20 or len(json.dumps({**envelope,'records':current},ensure_ascii=False).encode())>MAX_PAYLOAD:
                raise ValueError('One sample exceeds canonical batch limits')
        else:
            current = candidate
    if current:
        yield {**envelope,'records':current}

def checked(response):
    payload = response.json()
    if not response.ok:
        # Field paths are actionable. Do not print hidden source values on errors.
        issues = [{'path':x.get('path'),'message':x.get('message')} for x in payload.get('rejected',[])]
        raise ValueError(f'HTTP {response.status_code}: {payload.get("error","Import rejected")} {issues}')
    return payload

def legacy_mmau(manifest: Path, root: Path, dataset: str, existing: dict, choices_format: str, delimiter: str):
    """Explicit MMAU adapter reuses the original safe list parser/path resolver."""
    from import_mmau import load_rows, audio_location, parse_choices
    records, assets = [], {}
    for row in load_rows(manifest):
        audio, relative = audio_location(row,root)
        if not audio.is_file():
            raise ValueError(f'Missing audio: {relative}')
        raw = row.get('choices')
        if isinstance(raw,str) and choices_format=='lines':
            choices = [line.strip() for line in raw.splitlines() if line.strip()]
        elif isinstance(raw,str) and choices_format=='delimiter':
            if not delimiter:
                raise ValueError('--delimiter is required')
            choices = [part.strip() for part in raw.split(delimiter) if part.strip()]
        else:
            choices = parse_choices(raw)
        if not choices or not 2<=len(choices)<=50:
            raise ValueError('MMAU choices require 2–50 entries')
        matches = [i for i,choice in enumerate(choices) if choice==row.get('answer')]
        if len(matches)!=1:
            raise ValueError('MMAU answer must map to exactly one choice')
        duration=inspect_audio(audio)
        asset_id = existing.get(relative) or str(uuid.uuid5(uuid.UUID(dataset), relative))
        assets[relative] = {'audio_id':asset_id,'registered':relative in existing,'file':audio,'duration_seconds':duration}
        records.append({'sample_id':safe_id(str(row['id'])),'audio_id':asset_id,
                        'metadata':{'originalPath':relative,'originalRecordId':str(row['id']),'originalAnswer':row['answer']},
                        'items':[{'item_id':'question','fields':{
                            'prompt':{'type':'text','visibility':'worker','value':row['question']},
                            'options':{'type':'choices','visibility':'worker','value':[{'id':f'choice-{i+1}','label':label} for i,label in enumerate(choices)]}},
                            'reference':{'field':'options','value':f'choice-{matches[0]+1}'}}]})
    return records, assets, []

def canonical_audio(records,root,existing,remote_assets):
    """Optional explicit path adapter for canonical JSON. No filename guessing.
    Unregistered manifest UUIDs are planned aliases only when originalPath names
    an exact local WAV. Returned records use reused real IDs where available;
    upload replacement pins new IDs later. Conflicting known IDs never relink.
    """
    root=root.expanduser().resolve();assets={};declared={};alias_paths={}
    by_id={asset['id']:asset for asset in remote_assets}
    for record in records:
        if not isinstance(record,dict) or not isinstance(record.get('metadata',{}),dict):raise ValueError('Canonical records/metadata must be JSON objects.')
        supplied=record.get('audio_id')
        if not isinstance(supplied,str):raise ValueError('Canonical audio_id must be a UUID string, even for planned aliases.')
        uuid.UUID(supplied)
        relative=record.get('metadata',{}).get('originalPath')
        if not relative:
            if supplied in by_id:continue
            raise ValueError('Canonical records with unregistered audio need metadata.originalPath and --root, or registered audio IDs.')
        if not isinstance(relative,str) or Path(relative).is_absolute():raise ValueError('metadata.originalPath must be a relative WAV path.')
        file=(root/relative).resolve();file.relative_to(root)
        if supplied in by_id and by_id[supplied]['originalPath']!=relative:raise ValueError('Canonical audio ID conflicts with metadata.originalPath.')
        if relative in declared and declared[relative]!=supplied:raise ValueError('One WAV path declares conflicting canonical audio IDs.')
        if supplied in alias_paths and alias_paths[supplied]!=relative:raise ValueError('One canonical audio alias cannot name different WAV paths.')
        declared[relative]=supplied;alias_paths[supplied]=relative
        if not file.is_file() or file.suffix.lower()!='.wav' or not 0<file.stat().st_size<=MAX_AUDIO:raise ValueError('Canonical audio path must name an existing WAV of at most 10 MiB.')
        duration=inspect_audio(file)
        actual=existing.get(relative,supplied)
        record['audio_id']=actual
        assets[relative]={'audio_id':actual,'registered':relative in existing,'file':file,'duration_seconds':duration}
    return assets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adapter',choices=['paired-textgrid','mmau','canonical'])
    parser.add_argument('--root',type=Path)
    parser.add_argument('--manifest',type=Path)
    target=parser.add_mutually_exclusive_group()
    target.add_argument('--dataset-id',type=uuid.UUID)
    target.add_argument('--create-dataset',help='Create/reuse a dataset name in the project; requires --import')
    parser.add_argument('--dataset-version',default='v1')
    parser.add_argument('--source-version',default='v1')
    parser.add_argument('--retarget-dataset',action='store_true',help='Explicitly bind a canonical template to --dataset-id; source manifest stays unchanged')
    parser.add_argument('--record-id',help='Exact source_record_id for --inspect (from report acceptedItems)')
    parser.add_argument('--audio-id',help='Exact registered audio UUID for --inspect')
    parser.add_argument('--project-id',type=uuid.UUID)
    parser.add_argument('--user-id',help='Optional assertion; must match the verified login user ID')
    parser.add_argument('--base-url',default=os.environ.get('AUDIOLAB_BASE_URL',os.environ.get('DEMO_BASE_URL','http://localhost:5173')))
    parser.add_argument('--interactive',action='store_true',help='Choose project/dataset/adapter and paths by prompts')
    parser.add_argument('--username',help='Login name; password is prompted without echo')
    parser.add_argument('--auth',choices=['local','access'],default='local',help='Access requires HTTPS and an origin-bound private token file')
    parser.add_argument('--access-token-file',type=Path,help='Private JSON containing exact origin and borrowed human Access application token')
    auth=parser.add_mutually_exclusive_group()
    auth.add_argument('--credentials-file',type=Path,help='Private CLI JSON/password file or existing demo-login.txt')
    auth.add_argument('--cookie-file',type=Path,help='Private Netscape cookie jar from an existing local login')
    parser.add_argument('--assets-map',type=Path,help='Offline JSON object: original audio paths -> registered asset UUIDs')
    parser.add_argument('--offline',action='store_true')
    parser.add_argument('--output',type=Path,help='Defaults to a new temporary plan/report directory')
    parser.add_argument('--annotation-visibility',choices=['admin','worker'],default='admin')
    parser.add_argument('--require-textgrid',action='store_true')
    parser.add_argument('--choices-format',choices=['list','lines','delimiter'],default='list')
    parser.add_argument('--delimiter',default='')
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--inspect',action='store_true',help='Write an authorized source inspection to a private JSON file')
    mode.add_argument('--dry-run',action='store_true')
    mode.add_argument('--import',dest='apply',action='store_true')
    args=parser.parse_args()
    parsed=urlparse(args.base_url)
    if args.auth=='local' and (parsed.scheme!='http' or parsed.hostname not in ('localhost','127.0.0.1','::1') or parsed.username or parsed.password):
        parser.error('Only a controlled local HTTP server is supported')
    if args.auth=='access' and (args.offline or parsed.scheme!='https' or not args.access_token_file or args.credentials_file or args.cookie_file or args.username):
        parser.error('--auth access needs HTTPS and --access-token-file, without local credentials or --offline')
    if args.auth=='local' and args.access_token_file:
        parser.error('--access-token-file requires --auth access')
    if args.apply and (args.offline or (not args.interactive and not args.project_id)):
        parser.error('--import needs --project-id (or --interactive) and an authenticated server; user-id comes from login')
    if args.offline and args.interactive:
        parser.error('--interactive needs an authenticated local API; use explicit IDs for --offline')
    if args.create_dataset and not args.apply:
        parser.error('--create-dataset needs explicit --import; dry-run uses an existing dataset')
    if args.inspect and (args.offline or not args.dataset_id or not args.record_id or not args.audio_id or not args.project_id):
        parser.error('--inspect needs project-id, dataset-id, record-id, audio-id and authenticated local API')
    if args.offline and args.adapter=='canonical' and not args.dataset_id and args.manifest:
        args.dataset_id=uuid.UUID(strict_json(args.manifest)['dataset_id'])
    if args.retarget_dataset and (args.adapter!='canonical' or not args.dataset_id):
        parser.error('--retarget-dataset needs --adapter canonical and --dataset-id')
    if not args.interactive and not (args.dataset_id or args.create_dataset):
        parser.error('--dataset-id is required unless using --interactive or --create-dataset')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,60}',args.source_version):
        parser.error('Invalid source-version')
    args.output=args.output or Path(tempfile.gettempdir())/('audiolab-import-'+uuid.uuid4().hex[:12])
    args.progress={'attemptId':uuid.uuid4().hex,'mode':'import' if args.apply else 'inspect' if args.inspect else 'dry-run',
                   'status':'running','phase':'authentication','datasetId':str(args.dataset_id) if args.dataset_id else None,
                   'projectId':str(args.project_id) if args.project_id else None,'datasetName':args.create_dataset,'datasetVersion':args.dataset_version,'completedBatches':[],
                   'uploadedAudio':[],'reusedAudio':[],'acceptedItems':[], 'remoteStateMayHaveChanged':False}
    save_progress(args)
    try:
        if args.offline:
            args.adapter=args.adapter or 'paired-textgrid'
            return run_import(args,None,parser)
        with LocalAdminAPI(args.base_url,args.username,args.credentials_file,args.cookie_file,auth=args.auth,access_token_file=args.access_token_file) as api:
            if args.interactive:
                configure_interactive(args,api)
            args.adapter=args.adapter or 'paired-textgrid'
            if not args.project_id and args.dataset_id:
                # Resolve this exact dataset, never select the first/demo project.
                for member in api.memberships:
                    if member.get('role')!='admin':continue
                    found=checked(api.request('GET','/api/v1/datasets',params={'projectId':member['projectId']}))['datasets']
                    if any(row['id']==str(args.dataset_id) for row in found):args.project_id=member['projectId'];break
            if args.project_id:
                api.require_admin(args.project_id,args.user_id)
            else:raise ValueError('Choose an authorized project with --project-id or --interactive.')
            args.user_id=api.user_id
            save_progress(args,projectId=str(args.project_id))
            if args.create_dataset and not args.dataset_id:
                save_progress(args,phase='dataset-registration',remoteStateMayHaveChanged=True)
                args.dataset_id=ensure_dataset(api,str(args.project_id),args.create_dataset,args.dataset_version)
                print('Target dataset ID:',args.dataset_id)
            save_progress(args,datasetId=str(args.dataset_id),phase='planning')
            if args.inspect:
                inspection=checked(api.request('GET','/api/v1/dataset-ingestion/inspect',params={
                    'projectId':str(args.project_id),'userId':api.user_id,'datasetId':str(args.dataset_id),
                    'recordId':args.record_id,'audioId':args.audio_id}))
                private_json(args.output/'inspection.json',inspection)
                save_progress(args,status='complete',phase='inspection')
                print('Admin-only inspection written privately:',args.output/'inspection.json')
                return
            return run_import(args,api,parser)
    except BaseException as error:
        save_progress(args,status='interrupted' if isinstance(error,(KeyboardInterrupt,EOFError)) else 'failed',
                      failureType=type(error).__name__,recovery='Do not reset data. Review acknowledged writes; retry identical inputs to verify/reuse existing assets and immutable metadata. A failed request may already have committed.')
        raise


def ensure_dataset(api,project,name,version):
    """Explicit create-or-reuse; existing dataset contents are never reset.
    Registration is an independent API write and may remain empty if a later
    validation/upload fails. Reusing name+version makes recovery idempotent.
    """
    api.require_admin(project)
    rows=checked(api.request('GET','/api/v1/datasets',params={'projectId':project}))['datasets']
    existing=next((row for row in rows if row['name']==name and row['version']==version),None)
    if existing:return existing['id']
    response=api.request('POST','/api/v1/datasets',json={'projectId':project,'name':name,'version':version})
    if response.status_code==409:
        rows=checked(api.request('GET','/api/v1/datasets',params={'projectId':project}))['datasets']
        existing=next((row for row in rows if row['name']==name and row['version']==version),None)
        if existing:return existing['id']
    return checked(response)['dataset']['id']


def choose(rows,label):
    """Select real IDs from authenticated catalogs instead of typing UUIDs."""
    if not rows:raise ValueError('No available '+label+'. Register it in the selected project first.')
    for index,row in enumerate(rows,1):print(f"{index}. {row['name']} ({row['id']})")
    selected=input('Choose '+label+' number: ').strip()
    if not selected.isdigit() or not 1<=int(selected)<=len(rows):raise ValueError('Invalid '+label+' selection.')
    return rows[int(selected)-1]['id']


def configure_interactive(args,api):
    """Only catalog reads/prompts; no datasets, assets or assignments are created."""
    if not args.project_id:
        allowed={member['projectId'] for member in api.memberships if member.get('role')=='admin'}
        projects=checked(api.request('GET','/api/v1/projects'))['projects']
        args.project_id=choose([row for row in projects if row['id'] in allowed],'project')
    api.require_admin(args.project_id,args.user_id)
    if not args.dataset_id and not args.create_dataset:
        datasets=checked(api.request('GET','/api/v1/datasets',params={'projectId':str(args.project_id)}))['datasets']
        if args.apply:
            print('0. Create/reuse a dataset by name (a local database write)')
            for index,row in enumerate(datasets,1):print(f"{index}. {row['name']} ({row['id']})")
            selection=input('Choose dataset number: ').strip()
            if selection=='0':
                args.create_dataset=input('Dataset name: ').strip()
                args.dataset_version=input('Dataset version [v1]: ').strip() or 'v1'
                if not args.create_dataset or input('Register/reuse this dataset now? Type CREATE: ').strip()!='CREATE':raise ValueError('Dataset creation canceled.')
            elif selection.isdigit() and 1<=int(selection)<=len(datasets):args.dataset_id=datasets[int(selection)-1]['id']
            else:raise ValueError('Invalid dataset selection.')
        else:args.dataset_id=choose(datasets,'dataset')
    if not args.adapter:
        print('1. Paired WAV + TextGrid folder (PES)\n2. Canonical JSON (optional explicit WAV folder)\n3. MMAU JSON + audio folder')
        selection=input('Dataset format [1]: ').strip() or '1'
        if selection not in ('1','2','3'):raise ValueError('Unknown dataset format.')
        args.adapter={'1':'paired-textgrid','2':'canonical','3':'mmau'}[selection]
    if args.adapter!='canonical' and not args.root:args.root=Path(input('Audio/TextGrid folder: ').strip()).expanduser()
    if args.adapter in ('canonical','mmau') and not args.manifest:args.manifest=Path(input('JSON manifest file: ').strip()).expanduser()
    if args.adapter=='canonical' and not args.root:
        folder=input('Audio folder for metadata.originalPath (blank if all audio IDs are registered): ').strip()
        if folder:args.root=Path(folder).expanduser()
    if args.adapter=='paired-textgrid':
        visibility=input('Expose TextGrid for labeller editing? [y/N]: ').strip().lower()
        args.annotation_visibility='worker' if visibility=='y' else 'admin'
    print('Mode:', 'IMPORT (confirmation after planning)' if args.apply else 'DRY RUN — add --import to persist after review')


def run_import(args,api,parser):
    """Preserve existing bounded validation/upload/reuse logic after authentication."""
    save_progress(args,phase='planning')
    dataset=str(args.dataset_id)
    def request(method,path,**kwargs):
        if api is None:raise ValueError('Network access is disabled in offline mode.')
        return api.request(method,path,**kwargs)
    existing=strict_json(args.assets_map) if args.assets_map else {}
    remote_assets=[]
    if not args.offline:
        remote_assets=checked(request('GET','/api/v1/assets',params={'datasetId':dataset}))['assets']
        existing.update({a['originalPath']:a['id'] for a in remote_assets})
    if not isinstance(existing,dict) or not all(isinstance(k,str) and isinstance(v,str) for k,v in existing.items()):
        raise ValueError('assets-map must map paths to UUID strings')
    for value in existing.values():
        uuid.UUID(value)
    assets={};skipped=[]
    if args.adapter=='canonical':
        if not args.manifest:
            parser.error('--manifest is required')
        payload=strict_json(args.manifest)
        if not isinstance(payload,dict) or not isinstance(payload.get('records'),list):raise ValueError('Canonical manifest needs a JSON object with records array.')
        if args.create_dataset or args.retarget_dataset:payload['dataset_id']=dataset # Explicit named-target adapter; original manifest file is unchanged.
        if payload.get('schema_version')!=1 or payload.get('dataset_id')!=dataset:
            raise ValueError('Canonical schema_version/dataset_id mismatch')
        records=payload['records'];envelope={k:v for k,v in payload.items() if k!='records'}
        if args.root:
            assets=canonical_audio(records,args.root,existing,remote_assets)
    else:
        if not args.root or not args.root.expanduser().is_dir():
            parser.error('--root must be an existing audio directory')
        root=args.root.expanduser().resolve()
        if args.adapter=='paired-textgrid':
            records,assets,skipped=plan_paired(root,dataset,existing,args.annotation_visibility,args.require_textgrid)
        else:
            if not args.manifest:
                parser.error('--manifest is required')
            records,assets,skipped=legacy_mmau(args.manifest,root,dataset,existing,args.choices_format,args.delimiter)
        envelope={'schema_version':1,'dataset_id':dataset,'source_version':args.source_version,
                  'provenance':{'origin':args.adapter,'revision':args.source_version}}
    def verify_existing(asset,local):
        expected=hashlib.sha256(local['file'].read_bytes()).hexdigest()
        actual=asset.get('sha256')
        if not actual:
            # Legacy metadata may lack a digest. Verify selected bytes through the
            # authorized audio endpoint, with a bounded streaming read.
            response=request('GET',f"/api/v1/assets/{asset['id']}/audio",stream=True)
            try:
                if response.status_code!=200:raise ValueError('Unable to verify legacy audio bytes; no relinking performed.')
                digest=hashlib.sha256();size=0
                for chunk in response.iter_content(65536):
                    size+=len(chunk)
                    if size>MAX_AUDIO:raise ValueError('Existing audio exceeds CLI verification limit.')
                    digest.update(chunk)
                actual=digest.hexdigest()
            finally:response.close()
        if actual!=expected:raise ValueError('An existing audio path has different bytes; use a new dataset/identity instead of relinking annotations')
    for asset in remote_assets:
        local=assets.get(asset['originalPath'])
        if local:verify_existing(asset,local)
    if not records:raise ValueError('At least one canonical sample is required.')
    sample_ids=[r.get('sample_id') for r in records if isinstance(r,dict)]
    if any(not isinstance(value,str) for value in sample_ids):raise ValueError('Every sample_id must be a stable text identifier.')
    if len(set(sample_ids))!=len(sample_ids):raise ValueError('Duplicate sample IDs across the manifest; do not split one identity across batches.')
    plans=list(batches(envelope,records))
    # Use the exact TypeScript/Zod contract, including TextGrid parsing, rather
    # than maintain a second drifting Python approximation of the schema.
    validator=Path(__file__).with_name('validate_ingestion.cjs')
    for plan in plans:
        result=subprocess.run(['node',str(validator)],input=json.dumps(plan,ensure_ascii=False),text=True,capture_output=True)
        if result.returncode:
            raise ValueError('Canonical schema validation failed: '+result.stderr.strip())
    args.output.mkdir(parents=True,exist_ok=True)
    report=args.progress
    report.update({'samples':len(records),'skipped':skipped,'batches':len(plans),
            'existingAudio':sum(a['registered'] for a in assets.values()),'missingAudio':sum(not a['registered'] for a in assets.values())})
    def save():
        save_progress(args)
        for i,plan in enumerate(plans):
            private_json(args.output/f'batch-{i+1:04d}.json',plan,compact=True)
    save()
    actor={'projectId':str(args.project_id),'userId':getattr(args,'user_id',None)}
    if api is not None:
        save_progress(args,phase='server-validation')
        # Validate types/privacy/files before any upload. Missing audio is the only
        # permitted preflight error; membership is checked by the backend first.
        pending_audio=False
        for plan in plans:
            response=request('POST','/api/v1/dataset-ingestion/validate',params=actor,json=plan)
            if response.status_code==422:
                pending_audio=True
                result=response.json()
                if not result.get('rejected') or any(not e['path'].endswith('.audio_id') or 'Existing audio not found' not in e['message'] for e in result['rejected']):
                    checked(response)
            else:
                checked(response)
        save_progress(args,backendValidation='pending-audio' if pending_audio else 'passed')
    if not args.apply:
        save_progress(args,status='complete',phase='validation-only')
        print(f'DRY RUN: {len(records)} samples, {len(skipped)} skipped, {len(plans)} canonical batches. No dataset/audio/source writes. Output: {args.output}')
        if report['missingAudio']:
            print('Some audio IDs are planned placeholders, not registered assets. --import uploads/replaces them before validation.')
        return
    if args.interactive and input(f'Import {len(records)} samples into dataset {dataset}? Type IMPORT: ').strip()!='IMPORT':
        save_progress(args,status='canceled',phase='confirmation')
        print('Canceled. Plan files retained; no audio/source import. A newly registered dataset may remain.' if args.create_dataset else 'Canceled. Plan files retained; no dataset/audio writes.');return
    actor={'projectId':str(args.project_id),'userId':args.user_id}
    scoped=checked(request('GET','/api/v1/datasets',params={'projectId':str(args.project_id)}))['datasets']
    if not any(item['id']==dataset for item in scoped):
        raise ValueError('Dataset does not belong to the selected project; no uploads performed')
    try:
        replacements={}
        for relative,a in assets.items():
            if a['registered']:
                report['reusedAudio'].append({'originalPath':relative,'audioId':a['audio_id']})
                save_progress(args)
                continue
            save_progress(args,phase='audio-upload',pendingAudioPath=relative,remoteStateMayHaveChanged=True)
            with a['file'].open('rb') as handle:
                response=request('POST','/api/v1/assets',data={'datasetId':dataset,'originalPath':relative},files={'audio':(a['file'].name,handle,'audio/wav')})
            if response.status_code==409:
                latest=checked(request('GET','/api/v1/assets',params={'datasetId':dataset}))['assets']
                matched=next((x for x in latest if x['originalPath']==relative),None)
                if not matched:checked(response)
                verify_existing(matched,a)
                new_id=matched['id']
                report['reusedAudio'].append({'originalPath':relative,'audioId':new_id})
            else:
                new_id=checked(response)['asset']['id']
                report['uploadedAudio'].append({'originalPath':relative,'audioId':new_id})
            save_progress(args,pendingAudioPath=None)
            replacements[a['audio_id']]=new_id
        for record in records:
            record['audio_id']=replacements.get(record['audio_id'],record['audio_id'])
        plans=list(batches(envelope,records));save()
        for i,plan in enumerate(plans):
            save_progress(args,phase='metadata-batch',pendingBatch=i+1,remoteStateMayHaveChanged=True)
            checked(request('POST','/api/v1/dataset-ingestion/validate',params=actor,json=plan))
            imported=checked(request('POST','/api/v1/dataset-ingestion/import',params=actor,json=plan))
            report['acceptedItems'].extend(imported.get('accepted',[]))
            report['completedBatches'].append(i+1);save()
    except Exception:
        save()
        raise
    save_progress(args,status='complete',phase='complete',pendingBatch=None)
    print(f'Imported {len(records)} samples. Original sources and existing audio were preserved. Report: {args.output}/report.json')

if __name__=='__main__':
    try:
        main()
    except (EOFError,KeyboardInterrupt):
        print('Canceled. Check the last report before retrying; completed registration/import batches may remain.',file=sys.stderr)
        sys.exit(130)
    except (ValueError,KeyError,OSError,requests.RequestException,wave.Error) as exc:
        print(f'ERROR: {exc}',file=sys.stderr)
        sys.exit(1)
