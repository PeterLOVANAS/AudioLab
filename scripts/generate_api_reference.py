#!/usr/bin/env python3
"""Render reviewed operation metadata without inventing handler/request schemas.

The catalogue is manually reconciled against source; docs:check verifies handler
exports, example Zod shapes and that this rendering is current. Generation does
not call APIs or turn examples into live authorization/resource identities.
"""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def render():
    """Return the public reference, including per-operation permissions/examples."""
    operations = json.loads((ROOT / 'docs/api/operations.json').read_text())['operations']
    intro = '''# Backend API reference

Base path `/api/v1`. This reference covers the actual Worker routing boundary,
not direct service invocation. [Machine-readable catalogue](api/operations.json)
and [generated Zod request shapes](api/request-schemas.json) accompany each
operation. Semantic refinements/resource checks remain authoritative in services;
JSON Schema alone does not grant permission or validate all answer semantics.

## Authentication, errors and example identities

Production requires a verified Cloudflare Access human application identity linked
to an active AudioLab account and the required project role. Browser sessions use
Access cookies; the supported HTTPS CLI uses a private exact-origin application
token envelope. No public signup/service-token flow. [Authentication](AUTHENTICATION.md).
Writes require the exact configured Origin. Local DEV login is loopback-only and
rejected by production. Claimed `userId`, `adminId` or `labellerId` must match the
session where required; they never confer identity or project access.

Common protected errors: 401 absent/invalid/expired/revoked identity; 403 role,
project/resource/actor or Origin denial; 404 absent resource; 413 size limit; 503
invalid auth/binding/schema configuration; 500 unexpected internal failure.
Most errors are `{error:string, issues?:array}`. Check status before using a body;
an Access edge HTML challenge/redirect is not JSON success. Per-operation additions
are below. Generic JSON envelope is bounded at 512 KiB, multipart at 11 MiB;
route-specific limits are often stricter. Unknown APIs/methods fail closed.

All example UUIDs/actor strings below are **synthetic shape placeholders**, not
existing accounts. Replace them with IDs from authenticated responses. `{id}` /
`{version}` path parameters have the named resource meaning; IDs are UUID unless
the request explicitly allows legacy account strings. Opaque cursors must be
returned unchanged, not constructed from displayed row numbers. Bodies shown as
examples are not instructions to publish private source/reference fields.

For an authenticated local integration, reuse the supported client without logging
its credentials:

```python
import os, sys
sys.path.insert(0, "scripts")
from local_admin_api import LocalAdminAPI
with LocalAdminAPI(os.environ["AUDIOLAB_BASE_URL"],
                   credentials_file=os.environ["AUDIOLAB_LOCAL_STATE"] + "/admin-credentials.json") as api:
    response = api.request("GET", "/api/v1/projects")
    response.raise_for_status()
    projects = response.json()["projects"]
```

For HTTPS use `auth="access", access_token_file=PRIVATE_FILE` instead of local
credentials. The client pins the exact origin, verifies session, sets Origin,
does not follow redirects/proxies, and preserves TLS validation. Use the dataset
CLI for audio upload/source registration; do not copy tokens into curl arguments.

## Response contracts

See [choice training previews and question/rank distributions](api/CHOICE_RESULTS.md)
for additive block settings and analytics fields.

Referenced types and their complete fields:

- [Session](../lib/contracts/session.ts), [projects](../lib/contracts/projects.ts),
  [datasets/assets](../lib/contracts/datasets.ts).
- [Task Definition](../lib/backend/repositories/task-definitions.ts),
  [published/runtime Task Instance](../lib/contracts/task-instances.ts).
- [Assignment](../lib/contracts/assignment-api.ts),
  [annotation current/revision](../lib/contracts/annotation-api.ts).
- [Team/job/plan/progress](../lib/contracts/team-jobs.ts),
  [allocation](../lib/contracts/assignment-allocation.ts).
- [Source-field payloads](../lib/contracts/source-fields.ts),
  [ingestion service/report](../lib/backend/services/dataset-ingestion.ts).
- [JobResults](../lib/contracts/job-results.ts),
  [ResearchOverview](../lib/contracts/research-overview.ts),
  [ResearchExport](../lib/contracts/research-export.ts),
  [legacy candidate contracts](../lib/contracts/candidate-sets.ts).

Each operation also links its actual handler, including inline query/response
shapes. The catalogue is documentation, not a second persistence/validation model.
Answer values depend on pinned/resolved blocks; see [workflow](WORKFLOW.md) and
[metrics/export semantics](RESULTS.md). New candidate authoring is deprecated.

'''
    parts = [intro]
    for op in operations:
        request = op['request']
        if op.get('requestSchema'):
            request += ' — `' + op['requestSchema'] + '` in [generated request schemas](api/request-schemas.json).'
        example = op['method'] + ' ' + op['path']
        if op['query'] != 'none':
            example += ('&' if '?' in op['path'] else '?') + op['query']
        parts.append(f"## {op['method']} `{op['path']}`\n\n"
                     f"- Integration: {op['scope']}.\n"
                     f"- Authentication/permission: {op['permission']}.\n"
                     f"- Parameters: `{op['query']}`; path parameters as above.\n"
                     f"- Request schema: {request}.\n"
                     f"- Success response schema: {op['response']}.\n"
                     f"- Additional errors: {op['additionalErrors'] or 'common errors above'}.\n"
                     f"- [Authoritative handler](../{op['source']}).\n\n"
                     f"Representative request:\n\n```http\n{example}\n```\n")
        if op.get('exampleBody') is not None:
            # Large canonical example stays in its own licensed manifest.
            if op.get('requestSchema') == 'ingestionSchema':
                parts.append('\nBody: the [CC0 manifest](../examples/datasets/synthetic/manifest.json), '
                             'after the CLI has materialized registered target/audio IDs.\n')
            else:
                parts.append('\n```json\n' + json.dumps(op['exampleBody'], indent=2) + '\n```\n')
    parts.append('''
## Development-only and unsupported operations

The following are retained internal/legacy utilities, **403 in production** even
for an admin; use canonical ingestion and assigned queues instead:

| Operation | Purpose / authoritative source |
| --- | --- |
| POST `/source-records` | Mutable pilot import; [handler](../app/api/v1/source-records/route.ts) |
| GET/POST `/annotation-candidates` | Local curator; [handler](../app/api/v1/annotation-candidates/route.ts) |
| GET/POST `/labeller/audio-queue` | Auto-materializing practice queue; [handler](../app/api/v1/labeller/audio-queue/route.ts) |
| POST `/assets/{id}/metadata` | Local metadata repair; [handler](../app/api/v1/assets/[id]/metadata/route.ts) |
| POST `/auth/login` | Local password session only; production identity is Access |
| `/api/hello`, unknown methods/routes | Unsupported; mandatory boundary denies |

`app/api/research.ts` is a legacy module, not an active App Router endpoint.
Legacy candidate compatibility operations above retain their authorization and
provenance checks; they do not expose new workflow/adjudication APIs. Operator
first-admin/linking/revocation is controlled D1 tooling, not public registration.
''')
    return ''.join(parts)


if __name__ == '__main__':
    target = ROOT / 'docs/API.md'
    value = render()
    if '--check' in sys.argv:
        if not target.exists() or target.read_text() != value:
            raise SystemExit('API reference stale: python scripts/generate_api_reference.py')
        print('PASS rendered API reference matches reviewed operation catalogue')
    else:
        target.write_text(value)
