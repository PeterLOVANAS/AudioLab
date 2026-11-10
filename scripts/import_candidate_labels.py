#!/usr/bin/env python3
"""Curate model/human candidate annotations into AudioLab (not benchmark ground truth).

CSV columns:
  asset_id,label,provenance
  123e4567-e89b-42d3-a456-426614174000,"a bird chirps",model

Example:
  python3 scripts/import_candidate_labels.py --url http://localhost:5173 \
      --project-id <YOUR-PROJECT-UUID> --csv candidates.csv

The file is provided BY A RESEARCHER. This script intentionally does not
read source_labels/reference_answer: uploading those as voting candidates
would contaminate blind labelling and invalidate benchmark evaluation.
"""
import argparse,csv,json,urllib.request,urllib.error

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--url',default='http://localhost:5173')
    p.add_argument('--project-id',required=True)
    p.add_argument('--csv',required=True)
    opts=p.parse_args()
    with open(opts.csv,encoding='utf-8-sig',newline='') as source:
        rows=list(csv.DictReader(source))
    for number,row in enumerate(rows,1):
        payload={'projectId':opts.project_id,'assetId':row['asset_id'],
                 'label':row['label'],'provenance':row.get('provenance') or 'researcher'}
        req=urllib.request.Request(opts.url.rstrip('/')+'/api/v1/annotation-candidates',
            data=json.dumps(payload).encode('utf-8'),method='POST',
            headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=25) as result:
                print(f'{number}/{len(rows)}: {result.status}: {row["label"][:64]}')
        except urllib.error.HTTPError as e:
            print(f'ERROR row {number}: HTTP {e.code} {e.read().decode()}')
            raise

if __name__=='__main__':main()
