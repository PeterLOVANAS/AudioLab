"""Focused offline tests; never imports into a running or preserved database."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import wave

spec=importlib.util.spec_from_file_location('import_dataset',Path(__file__).with_name('import_dataset.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
GRID='''File type = "ooTextFile"
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
DATASET='11111111-1111-4111-8111-111111111111'
class ImportTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
  with wave.open(str(self.root/'sample.wav'),'wb') as out:
   out.setnchannels(1);out.setsampwidth(2);out.setframerate(100);out.writeframes(b'\0\0'*100)
  (self.root/'sample.TextGrid').write_text(GRID,encoding='utf-8')
 def tearDown(self):self.temp.cleanup()
 def test_exact_file_and_reuse(self):
  records,assets,skipped=module.plan_paired(self.root,DATASET,{'sample.wav':DATASET},'worker')
  self.assertEqual(records[0]['audio_id'],DATASET);self.assertTrue(assets['sample.wav']['registered']);self.assertEqual(skipped,[])
  artifact=records[0]['items'][0]['fields']['alignment']['file']
  raw=(self.root/'sample.TextGrid').read_bytes();self.assertEqual(base64.b64decode(artifact['content_base64']),raw)
  self.assertEqual(artifact['sha256'],hashlib.sha256(raw).hexdigest())
 def test_utf16_original_bytes(self):
  raw=GRID.replace('hello','สวัสดี').encode('utf-16')
  (self.root/'sample.TextGrid').write_bytes(raw)
  field=module.source_file(self.root/'sample.TextGrid','admin')
  self.assertEqual(base64.b64decode(field['file']['content_base64']),raw);self.assertIn('สวัสดี',field['value'])
 def test_pairing(self):
  (self.root/'sample.TextGrid').unlink()
  with self.assertRaises(ValueError):module.plan_paired(self.root,DATASET,{},'worker',True)
  sidecar=self.root/'sample.TextGrid';sidecar.write_text(GRID)
  # macOS may be case-insensitive: simulate the ambiguous listing that can
  # actually occur on a case-sensitive corpus volume.
  with patch.object(Path,'iterdir',return_value=[sidecar,sidecar]):
   with self.assertRaises(ValueError):module.plan_paired(self.root,DATASET,{},'worker')
 def test_duplicate_json(self):
  p=self.root/'bad.json';p.write_text('{"a":1,"a":2}')
  with self.assertRaises(ValueError):module.strict_json(p)
 def test_bounded_batches(self):
  records,_,_=module.plan_paired(self.root,DATASET,{},'worker')
  rows=[{**records[0],'sample_id':f's{i}'} for i in range(45)]
  self.assertEqual([len(p['records']) for p in module.batches({'schema_version':1},rows)],[20,20,5])
 def test_canonical_explicit_audio_paths(self):
  remote=[{'id':DATASET,'originalPath':'sample.wav'}]
  placeholder='22222222-2222-4222-8222-222222222222'
  rows=[{'audio_id':placeholder,'metadata':{'originalPath':'sample.wav'}}]
  assets=module.canonical_audio(rows,self.root,{'sample.wav':DATASET},remote)
  self.assertEqual(rows[0]['audio_id'],DATASET);self.assertTrue(assets['sample.wav']['registered'])
  rows=[{'audio_id':placeholder,'metadata':{'originalPath':'sample.wav'}}]
  self.assertFalse(module.canonical_audio(rows,self.root,{},[] )['sample.wav']['registered'])
  with self.assertRaises(ValueError):module.canonical_audio([{'audio_id':placeholder}],self.root,{},[])
  with self.assertRaises(ValueError):module.canonical_audio([{'audio_id':None,'metadata':{'originalPath':'sample.wav'}}],self.root,{},[])
  with self.assertRaises(ValueError):module.canonical_audio([{'audio_id':placeholder,'metadata':5}],self.root,{},[])
  with self.assertRaises(ValueError):module.canonical_audio([{'audio_id':placeholder,'metadata':{'originalPath':'../escape.wav'}}],self.root,{},[])
  with self.assertRaises(ValueError):module.canonical_audio([{'audio_id':DATASET,'metadata':{'originalPath':'other.wav'}}],self.root,{'sample.wav':DATASET},remote)
 def test_write_and_remote_guards(self):
  base=['python3',str(Path(module.__file__)),'--root',str(self.root),'--dataset-id',DATASET,'--output',str(self.root/'out')]
  remote=subprocess.run(base+['--offline','--base-url','https://example.com'],text=True,capture_output=True)
  self.assertNotEqual(remote.returncode,0);self.assertIn('controlled local HTTP',remote.stderr)
  writes=subprocess.run(base+['--import'],text=True,capture_output=True)
  self.assertNotEqual(writes.returncode,0);self.assertIn('--project-id',writes.stderr)
  create=subprocess.run(['python3',str(Path(module.__file__)),'--create-dataset','New data','--dry-run'],text=True,capture_output=True)
  self.assertNotEqual(create.returncode,0);self.assertIn('explicit --import',create.stderr)
 def test_cli_dry_run_schema_and_idempotency(self):
  command=['python3',str(Path(module.__file__)),'--root',str(self.root),'--dataset-id',DATASET,'--offline','--annotation-visibility','worker','--output',str(self.root/'out'),'--dry-run']
  first=subprocess.run(command,text=True,capture_output=True);self.assertEqual(first.returncode,0,first.stderr)
  payload=(self.root/'out/batch-0001.json').read_bytes()
  second=subprocess.run(command,text=True,capture_output=True);self.assertEqual(second.returncode,0,second.stderr)
  self.assertEqual(payload,(self.root/'out/batch-0001.json').read_bytes())
  self.assertEqual(json.loads((self.root/'out/report.json').read_text())['completedBatches'],[])
  (self.root/'sample.TextGrid').write_text('not TextGrid')
  invalid=subprocess.run(command,text=True,capture_output=True);self.assertNotEqual(invalid.returncode,0)
 def test_pcm_truncation_empty_and_alias_guards(self):
  from shutil import copyfile
  audio=self.root/'sample.wav'
  self.assertEqual(module.inspect_audio(audio),1)
  raw=audio.read_bytes();audio.write_bytes(raw[:-10])
  with self.assertRaisesRegex(ValueError,'Truncated'):module.inspect_audio(audio)
  audio.write_bytes(raw);copyfile(audio,self.root/'other.wav')
  alias='22222222-2222-4222-8222-222222222222'
  records=[{'audio_id':alias,'metadata':{'originalPath':name}} for name in ['sample.wav','other.wav']]
  with self.assertRaisesRegex(ValueError,'alias'):module.canonical_audio(records,self.root,{},[])
 def test_offline_canonical_template_and_private_reports(self):
  import os
  manifest=self.root/'manifest.json'
  payload={'schema_version':1,'dataset_id':DATASET,'source_version':'v1','provenance':{'origin':'synthetic','revision':'1'},'records':[{'sample_id':'sample','audio_id':DATASET,'metadata':{'originalPath':'sample.wav'},'items':[{'item_id':'question','fields':{'prompt':{'type':'text','visibility':'worker','value':'Listen'}}}]}]}
  manifest.write_text(json.dumps(payload));before=manifest.read_bytes();out=self.root/'out'
  base=['python3',str(Path(module.__file__)),'--adapter','canonical','--manifest',str(manifest),'--root',str(self.root),'--offline','--output',str(out)]
  inferred=subprocess.run(base,text=True,capture_output=True);self.assertEqual(inferred.returncode,0,inferred.stderr)
  changed=subprocess.run(base+['--dataset-id','22222222-2222-4222-8222-222222222222','--retarget-dataset'],text=True,capture_output=True)
  self.assertEqual(changed.returncode,0,changed.stderr);self.assertEqual(manifest.read_bytes(),before)
  self.assertEqual(json.loads((out/'batch-0001.json').read_text())['dataset_id'],'22222222-2222-4222-8222-222222222222')
  self.assertEqual((out/'report.json').stat().st_mode&0o777,0o600)
  self.assertEqual(len(list((out/'attempts').glob('*.json'))),2)
  payload['records']=[];manifest.write_text(json.dumps(payload))
  empty=subprocess.run(base,text=True,capture_output=True);self.assertNotEqual(empty.returncode,0)
  self.assertEqual(json.loads((out/'report.json').read_text())['status'],'failed')
if __name__=='__main__':unittest.main()
