#!/usr/bin/env python3
"""Compare real active queue/overview APIs with read-only disposable D1 state."""
import argparse,pathlib,sqlite3,requests
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state-root',required=True);p.add_argument('--base-url',default='http://127.0.0.1:5175');a=p.parse_args();root=pathlib.Path(a.state_root);base=a.base_url.rstrip('/')
assert (root/'DISPOSABLE_DEMO.json').is_file() and base.startswith(('http://127.0.0.1:','http://localhost:'))
for file in (root/'v3/d1').rglob('*.sqlite'):
 db=sqlite3.connect(file.resolve().as_uri()+'?mode=ro',uri=True)
 if db.execute("SELECT 1 FROM sqlite_master WHERE name='annotation_jobs'").fetchone():break
 db.close()
pid=db.execute("SELECT id FROM projects WHERE name='AudioLab Research'").fetchone()[0]
archived={row[0] for row in db.execute("SELECT a.id FROM assignments a JOIN annotation_job_assignments ja ON ja.assignment_id=a.id JOIN annotation_jobs j ON j.id=ja.job_id WHERE a.project_id=? AND a.labeller_user_id='demo-alice' AND j.deleted_at IS NOT NULL",(pid,))};assert archived
expected=db.execute("SELECT COUNT(*) FROM assignments a WHERE project_id=? AND labeller_user_id='demo-alice' AND NOT EXISTS(SELECT 1 FROM annotation_job_assignments ja JOIN annotation_jobs j ON j.id=ja.job_id WHERE ja.assignment_id=a.id AND j.deleted_at IS NOT NULL)",(pid,)).fetchone()[0];db.close()
s=requests.Session();s.trust_env=False;s.headers['Origin']=base
r=s.post(base+'/api/v1/auth/login',json={'username':'demo-alice','password':(root/'demo-login.txt').read_text().splitlines()[-1]});assert r.ok
for route,field in [('queue','assignments'),('queue/page','assignments'),('assigned-queue','groups')]:
 r=s.get(base+f'/api/v1/labeller/{route}?projectId={pid}&labellerId=demo-alice');assert r.ok,r.text
 assert not any(row.get('assignmentId',row.get('id')) in archived for row in r.json()[field])
r=s.get(base+f'/api/v1/labeller/overview?projectId={pid}&labellerId=demo-alice');assert r.ok,r.text;assert r.json()['counts']['total']==expected
s.post(base+'/api/v1/auth/logout',json={})
print('PASS actual owner queues (current, legacy and paged) and overview totals exclude archived jobs; read-only disposable D1 matches API counts.')
