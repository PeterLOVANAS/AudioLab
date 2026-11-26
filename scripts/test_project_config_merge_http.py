#!/usr/bin/env python3
"""Project Configuration merge regression on marked disposable Worker/D1 only."""
import argparse,pathlib,requests,uuid,json
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state-root',required=True);p.add_argument('--base-url',default='http://127.0.0.1:5175');a=p.parse_args();root=pathlib.Path(a.state_root);base=a.base_url.rstrip('/')
assert (root/'DISPOSABLE_DEMO.json').is_file() and base.startswith(('http://127.0.0.1:','http://localhost:'))
password=(root/'demo-login.txt').read_text().splitlines()[-1]
def client(user=None):
 s=requests.Session();s.trust_env=False;s.headers['Origin']=base
 if user:
  r=s.post(base+'/api/v1/auth/login',json={'username':user,'password':password});assert r.ok,r.text
 return s
def call(s,method,path,body=None,status=200):
 r=s.request(method,base+'/api/v1/'+path,json=body,timeout=120);assert r.status_code==status,(path,r.status_code,r.text[:1000]);return r.json()
admin=client('demo-admin');worker=client('demo-alice');anon=client();original=call(admin,'GET','projects')['projects']
slug='merge-test-'+str(uuid.uuid4())[:12];project=call(admin,'POST','projects',{'name':'API — Project Configuration merge test','slug':slug},201)['project'];assert project['slug']==slug
assert any(p['id']==project['id'] and p['slug']==slug for p in call(admin,'GET','projects')['projects'])
assert any(m['projectId']==project['id'] and m['role']=='admin' for m in call(admin,'GET','auth/session')['memberships'])
call(admin,'POST','projects',{'name':'Duplicate','slug':slug},409)
call(worker,'POST','projects',{'name':'Forbidden','slug':'forbidden-'+str(uuid.uuid4())},403);call(anon,'POST','projects',{'name':'Forbidden','slug':'anonymous'},401)
call(admin,'POST','projects',{'name':'Spoof','slug':'spoof','userId':'demo-bob'},400)
assert project['id'] not in [p['id'] for p in call(worker,'GET','projects')['projects']]
draft={'name':'Merge starter draft','description':'','domain':'general','instructions':'Annotate the recording according to this task.','policy':{'requiredIndependentVotes':1,'blindToOthers':True,'requiresReview':False},'blocks':[{'id':str(uuid.uuid4()),'type':'text','label':'Annotation','required':False,'multiline':True}]}
definition=call(admin,'POST','task-definitions',{'projectId':project['id'],'draft':draft},201)['taskDefinition'];assert definition['publishedVersion']==0
assert any(d['id']==definition['id'] and d['draftRevision']==1 for d in call(admin,'GET','task-definitions?projectId='+project['id'])['definitions'])
call(admin,'POST','task-definitions',{'projectId':project['id'],'name':'Old incompatible payload'},400)
call(worker,'GET','task-definitions?projectId='+project['id'],status=403)
call(admin,'POST','auth/logout',{});admin=client('demo-admin');saved=call(admin,'GET','task-definitions/'+definition['id'])['taskDefinition'];assert saved['draft']==draft
names=set()
for project_row in original:
 names.update(d['name'] for d in call(admin,'GET','datasets?projectId='+project_row['id'])['datasets'])
assert {'MMAU test-mini','PES-corpus'}<=names
fixture=json.loads((root/'RESEARCH_EXPORT_EVIDENCE.json').read_text());pid=fixture['projectId'];jobid=fixture['jobId']
job=call(admin,'GET',f'team-jobs?action=detail&projectId={pid}&jobId={jobid}')
preview={**job['plan']['input'],'jobId':str(uuid.uuid4()),'name':'Merge read-only allocation preview'}
assert len(call(admin,'POST','team-jobs?action=preview',preview)['plan']['pairs'])==len(job['plan']['pairs'])
queue=call(worker,'GET',f'labeller/assigned-queue?projectId={pid}&labellerId=demo-alice&queueJobId={jobid}');assert queue['groups']
aid=queue['groups'][0]['assignmentId'];task=call(worker,'GET','assignments/'+aid)['taskInstance'];assert len(task['audioAssets'])==2 and task['resolvedDefinition']
assert call(worker,'GET',f'assignments/{aid}/annotation?labellerId=demo-alice')['current']['status']=='submitted'
assert job['summary']['submitted']==2 and job['summary']['assignments']==3
assert admin.get(base+'/').status_code==200
call(worker,'POST','auth/logout',{});call(admin,'POST','auth/logout',{})
(root/'PROJECT_CONFIG_MERGE_EVIDENCE.json').write_text(json.dumps({'createdProjectId':project['id'],'definitionId':definition['id'],'existingJobId':jobid,'workspaceAssignmentId':aid},indent=2))
print('PASS actual Worker/D1: authenticated project/admin-membership creation, slug conflict, draft persistence after relogin, actor/role denial, MMAU/PES access, assignment preview, existing Workspace audio/final revision and current job progress counts; SSR HTTP 200.')
