# Backend API reference

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

## GET `/api/v1/auth/session`

- Integration: production.
- Authentication/permission: Public discovery.
- Parameters: `none`; path parameters as above.
- Request schema: No body.
- Success response schema: 200 {user:null|SessionUser,memberships,mode,configured,loginUrl}; errors may be described by status/error in discovery.
- Additional errors: 503 config/schema unavailable.
- [Authoritative handler](../app/api/v1/auth/session/route.ts).

Representative request:

```http
GET /api/v1/auth/session
```
## POST `/api/v1/auth/login`

- Integration: development-only.
- Authentication/permission: Explicit local DEV loopback only.
- Parameters: `none`; path parameters as above.
- Request schema: {username:string,password:string}.
- Success response schema: 200 {ok:true}; local session cookie.
- Additional errors: 400 malformed, 401 invalid, 403 production, 429 limiter.
- [Authoritative handler](../app/api/v1/auth/login/route.ts).

Representative request:

```http
POST /api/v1/auth/login
```

```json
{
  "username": "local-admin",
  "password": "EXAMPLE_ONLY_NOT_A_REAL_PASSWORD"
}
```
## POST `/api/v1/auth/logout`

- Integration: production.
- Authentication/permission: Authenticated current identity + exact Origin.
- Parameters: `none`; path parameters as above.
- Request schema: {}.
- Success response schema: 200 {ok:true,logoutUrl:"/cdn-cgi/access/logout"}; clears DEV cookie/revokes exact Access token.
- Additional errors: 401/403 invalid session.
- [Authoritative handler](../app/api/v1/auth/logout/route.ts).

Representative request:

```http
POST /api/v1/auth/logout
```

```json
{}
```
## GET `/api/v1/projects`

- Integration: production.
- Authentication/permission: Authenticated member; project/resource scope checked.
- Parameters: `none`; path parameters as above.
- Request schema: No body.
- Success response schema: 200 {projects: Project[]} (memberships only).
- Additional errors: common errors above.
- [Authoritative handler](../app/api/v1/projects/route.ts).

Representative request:

```http
GET /api/v1/projects
```
## POST `/api/v1/projects`

- Integration: production.
- Authentication/permission: Authenticated administrator in at least one existing project.
- Parameters: `none`; path parameters as above.
- Request schema: Strict {name:1..128,slug:lowercase-hyphen <=80}.
- Success response schema: 201 {project:Project}; creator admin membership atomic.
- Additional errors: 400 invalid, 409 duplicate slug.
- [Authoritative handler](../app/api/v1/projects/route.ts).

Representative request:

```http
POST /api/v1/projects
```

```json
{
  "name": "Synthetic study",
  "slug": "synthetic-study"
}
```
## GET `/api/v1/datasets`

- Integration: production.
- Authentication/permission: Authenticated member; project/resource scope checked.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001`; path parameters as above.
- Request schema: projectId UUID.
- Success response schema: 200 {datasets:Dataset[]}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/datasets/route.ts).

Representative request:

```http
GET /api/v1/datasets?projectId=00000000-0000-4000-8000-000000000001
```
## POST `/api/v1/datasets`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: Strict {projectId:UUID,name:1..128,version:1..100,description?:<=2000}.
- Success response schema: 201 {dataset:Dataset}.
- Additional errors: 400/404/409.
- [Authoritative handler](../app/api/v1/datasets/route.ts).

Representative request:

```http
POST /api/v1/datasets
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "name": "Synthetic tones",
  "version": "v1"
}
```
## GET `/api/v1/assets`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `datasetId=00000000-0000-4000-8000-000000000002`; path parameters as above.
- Request schema: datasetId UUID.
- Success response schema: 200 {assets:AudioAsset[]}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/assets/route.ts).

Representative request:

```http
GET /api/v1/assets?datasetId=00000000-0000-4000-8000-000000000002
```
## POST `/api/v1/assets`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: multipart/form-data: datasetId UUID; audio File; originalPath? nonempty <=500; WAV <=10 MiB.
- Success response schema: 201 {asset:AudioAsset}.
- Additional errors: 400/404/409/413/415.
- [Authoritative handler](../app/api/v1/assets/route.ts).

Representative request:

```http
POST /api/v1/assets
```
## GET `/api/v1/assets/{id}/audio`

- Integration: production.
- Authentication/permission: Project admin or assigned owner of this primary/slot audio.
- Parameters: `none`; path parameters as above.
- Request schema: id asset UUID; optional Range:bytes=start-end.
- Success response schema: 200 audio/wav, 206 partial; HEAD headers without body.
- Additional errors: 400/404 missing object, 416 bad range.
- [Authoritative handler](../app/api/v1/assets/[id]/audio/route.ts).

Representative request:

```http
GET /api/v1/assets/{id}/audio
```
## HEAD `/api/v1/assets/{id}/audio`

- Integration: production.
- Authentication/permission: Project admin or assigned owner of this primary/slot audio.
- Parameters: `none`; path parameters as above.
- Request schema: No body; Vinext synthesizes HEAD from the exported GET, and the proxy explicitly permits audio HEAD.
- Success response schema: 200 audio/wav, 206 partial; HEAD headers without body.
- Additional errors: 400/404 missing object, 416 bad range.
- [Authoritative handler](../app/api/v1/assets/[id]/audio/route.ts).

Representative request:

```http
HEAD /api/v1/assets/{id}/audio
```
## GET `/api/v1/source-records`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `assetId=00000000-0000-4000-8000-000000000003`; path parameters as above.
- Request schema: assetId UUID.
- Success response schema: 200 {sourceRecords:[{sourceRecordId,sourceDomain,question,choices,metadata:{}}]}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/source-records/route.ts).

Representative request:

```http
GET /api/v1/source-records?assetId=00000000-0000-4000-8000-000000000003
```
## GET `/api/v1/source-fields`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&datasetId=00000000-0000-4000-8000-000000000002&userId=SESSION_USER_ID&recordId=SOURCE_RECORD_ID&view=admin`; path parameters as above.
- Request schema: UUID project/dataset, own userId, external recordId<=200, view admin|worker, assetId? UUID.
- Success response schema: 200 {source:SourceFieldPayload|WorkerSourcePayload}; assigned workers use pinned task, not this admin endpoint.
- Additional errors: 400/404/503 schema.
- [Authoritative handler](../app/api/v1/source-fields/route.ts).

Representative request:

```http
GET /api/v1/source-fields?projectId=00000000-0000-4000-8000-000000000001&datasetId=00000000-0000-4000-8000-000000000002&userId=SESSION_USER_ID&recordId=SOURCE_RECORD_ID&view=admin
```
## POST `/api/v1/dataset-ingestion/validate`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&userId=SESSION_USER_ID`; path parameters as above.
- Request schema: ingestionSchema; body <=256 KiB; registered audio/dataset IDs — `ingestionSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 200 {ok:true,persisted:boolean,accepted:Array<{source_record_id:string,id:string,audio_id:string}>,rejected:[]}; 422 {ok:false,accepted:[],rejected:Array<{path:string,message:string}>}.
- Additional errors: 400/404/409/413/422.
- [Authoritative handler](../app/api/v1/dataset-ingestion/validate/route.ts).

Representative request:

```http
POST /api/v1/dataset-ingestion/validate?projectId=00000000-0000-4000-8000-000000000001&userId=SESSION_USER_ID
```

Body: the [CC0 manifest](../examples/datasets/synthetic/manifest.json), after the CLI has materialized registered target/audio IDs.
## POST `/api/v1/dataset-ingestion/import`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&userId=SESSION_USER_ID`; path parameters as above.
- Request schema: ingestionSchema; body <=256 KiB; registered audio/dataset IDs — `ingestionSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 200 {ok:true,persisted:boolean,accepted:Array<{source_record_id:string,id:string,audio_id:string}>,rejected:[]}; 422 {ok:false,accepted:[],rejected:Array<{path:string,message:string}>}.
- Additional errors: 400/404/409/413/422.
- [Authoritative handler](../app/api/v1/dataset-ingestion/import/route.ts).

Representative request:

```http
POST /api/v1/dataset-ingestion/import?projectId=00000000-0000-4000-8000-000000000001&userId=SESSION_USER_ID
```

Body: the [CC0 manifest](../examples/datasets/synthetic/manifest.json), after the CLI has materialized registered target/audio IDs.
## GET `/api/v1/dataset-ingestion/inspect`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&userId=SESSION_USER_ID&datasetId=00000000-0000-4000-8000-000000000002&recordId=SOURCE_RECORD_ID&audioId=00000000-0000-4000-8000-000000000003`; path parameters as above.
- Request schema: Exact project/dataset/external record/audio identity; own actor.
- Success response schema: 200 {item:CanonicalStoredItem|null,labels:DatasetLabel[]}; exact protected originals from source-field repository; admin-only.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/dataset-ingestion/inspect/route.ts).

Representative request:

```http
GET /api/v1/dataset-ingestion/inspect?projectId=00000000-0000-4000-8000-000000000001&userId=SESSION_USER_ID&datasetId=00000000-0000-4000-8000-000000000002&recordId=SOURCE_RECORD_ID&audioId=00000000-0000-4000-8000-000000000003
```
## GET `/api/v1/task-definitions`

- Integration: production.
- Authentication/permission: Authenticated member; project/resource scope checked.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001`; path parameters as above.
- Request schema: projectId UUID.
- Success response schema: 200 {definitions:TaskDefinitionSummary[]}; compact catalog, no drafts.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/task-definitions/route.ts).

Representative request:

```http
GET /api/v1/task-definitions?projectId=00000000-0000-4000-8000-000000000001
```
## POST `/api/v1/task-definitions`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: createTaskDefinitionSchema — `createTaskDefinitionSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 201 {taskDefinition:TaskDefinitionDetail}.
- Additional errors: 400/404/422.
- [Authoritative handler](../app/api/v1/task-definitions/route.ts).

Representative request:

```http
POST /api/v1/task-definitions
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "draft": {
    "name": "Synthetic task",
    "description": "",
    "domain": "sound",
    "instructions": "Listen independently.",
    "policy": {
      "requiredIndependentVotes": 2,
      "blindToOthers": true,
      "requiresReview": false
    },
    "blocks": [
      {
        "id": "present",
        "type": "boolean",
        "label": "Is the tone audible?",
        "required": true
      }
    ]
  }
}
```
## GET `/api/v1/task-definitions/{id}`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: id definition UUID.
- Success response schema: 200 {taskDefinition:TaskDefinitionDetail}.
- Additional errors: 400/404/422.
- [Authoritative handler](../app/api/v1/task-definitions/[id]/route.ts).

Representative request:

```http
GET /api/v1/task-definitions/{id}
```
## PUT `/api/v1/task-definitions/{id}`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: updateTaskDefinitionSchema — `updateTaskDefinitionSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 200 {taskDefinition:TaskDefinitionDetail}; draft revision increments.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/task-definitions/[id]/route.ts).

Representative request:

```http
PUT /api/v1/task-definitions/{id}
```

```json
{
  "expectedRevision": 1,
  "draft": {
    "name": "Synthetic task",
    "description": "",
    "domain": "sound",
    "instructions": "Listen independently.",
    "policy": {
      "requiredIndependentVotes": 2,
      "blindToOthers": true,
      "requiresReview": false
    },
    "blocks": [
      {
        "id": "present",
        "type": "boolean",
        "label": "Is the tone audible?",
        "required": true
      }
    ]
  }
}
```
## POST `/api/v1/task-definitions/{id}/publish`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: publishTaskDefinitionSchema — `publishTaskDefinitionSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 201 {published:{id,version,definition,publishedAt}}.
- Additional errors: 400/404/409 stale counters/422 unsupported.
- [Authoritative handler](../app/api/v1/task-definitions/[id]/publish/route.ts).

Representative request:

```http
POST /api/v1/task-definitions/{id}/publish
```

```json
{
  "expectedRevision": 1,
  "expectedPublishedVersion": 0
}
```
## GET `/api/v1/task-definitions/{id}/versions/{version}`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: id UUID; version positive integer.
- Success response schema: 200 {published:{id,version,definition,publishedAt}}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/task-definitions/[id]/versions/[version]/route.ts).

Representative request:

```http
GET /api/v1/task-definitions/{id}/versions/{version}
```
## GET `/api/v1/task-instances`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&datasetId=00000000-0000-4000-8000-000000000002`; path parameters as above.
- Request schema: projectId UUID; datasetId? UUID.
- Success response schema: 200 {instances:TaskInstanceSummary[]}.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/task-instances/route.ts).

Representative request:

```http
GET /api/v1/task-instances?projectId=00000000-0000-4000-8000-000000000001&datasetId=00000000-0000-4000-8000-000000000002
```
## POST `/api/v1/task-instances`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: createTaskInstanceSchema; ordered audio/source arrays checked together — `createTaskInstanceSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 201 {taskInstance:TaskInstancePreview}.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/task-instances/route.ts).

Representative request:

```http
POST /api/v1/task-instances
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "definitionId": "00000000-0000-4000-8000-000000000004",
  "definitionVersion": 1,
  "assetId": "00000000-0000-4000-8000-000000000003"
}
```
## GET `/api/v1/task-instances/{id}`

- Integration: production.
- Authentication/permission: Project admin or assigned owner of this Task Instance.
- Parameters: `none`; path parameters as above.
- Request schema: id UUID.
- Success response schema: 200 {taskInstance:TaskInstancePreview}; pinned worker-safe context.
- Additional errors: 400/404/422.
- [Authoritative handler](../app/api/v1/task-instances/[id]/route.ts).

Representative request:

```http
GET /api/v1/task-instances/{id}
```
## GET `/api/v1/project-members`

- Integration: production.
- Authentication/permission: Authenticated member; project/resource scope checked.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001`; path parameters as above.
- Request schema: projectId UUID.
- Success response schema: 200 {members:ProjectMember[]}; labeller sees only self.
- Additional errors: common errors above.
- [Authoritative handler](../app/api/v1/project-members/route.ts).

Representative request:

```http
GET /api/v1/project-members?projectId=00000000-0000-4000-8000-000000000001
```
## POST `/api/v1/project-members`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: createMemberSchema; active linked account required in production — `createMemberSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 201 {member:ProjectMember}.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/project-members/route.ts).

Representative request:

```http
POST /api/v1/project-members
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "userId": "example-worker",
  "displayName": "Example labeller",
  "role": "labeller"
}
```
## GET `/api/v1/worker-profiles`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001`; path parameters as above.
- Request schema: projectId UUID.
- Success response schema: 200 {workers:WorkerProfile[],teams:Team[]}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/worker-profiles/route.ts).

Representative request:

```http
GET /api/v1/worker-profiles?projectId=00000000-0000-4000-8000-000000000001
```
## POST `/api/v1/worker-profiles`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: workerProfileSchema; profile is eligibility, not auth identity — `workerProfileSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 200 {workers:WorkerProfile[]}.
- Additional errors: 400/409/422.
- [Authoritative handler](../app/api/v1/worker-profiles/route.ts).

Representative request:

```http
POST /api/v1/worker-profiles
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "userId": "example-worker",
  "country": "",
  "profession": "",
  "languages": [],
  "experienceYears": 0,
  "active": true,
  "metadata": {}
}
```
## POST `/api/v1/worker-profiles?action=team`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: teamSchema; active/account-ready project labellers only — `teamSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 200 {teamId,teams:Team[]}; teamId? updates future membership.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/worker-profiles/route.ts).

Representative request:

```http
POST /api/v1/worker-profiles?action=team
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "name": "Independent labellers",
  "memberIds": [
    "example-worker",
    "example-worker-b"
  ]
}
```
## GET `/api/v1/team-jobs`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001`; path parameters as above.
- Request schema: UUID project; jobId/assignmentId for inspection; items accepts cursor?; list includeArchived=1 optional.
- Success response schema: 200 {jobs:JobSummary[]}.
- Additional errors: 400/404/422.
- [Authoritative handler](../app/api/v1/team-jobs/route.ts).

Representative request:

```http
GET /api/v1/team-jobs?projectId=00000000-0000-4000-8000-000000000001
```
## GET `/api/v1/team-jobs?action=catalog`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001`; path parameters as above.
- Request schema: UUID project; jobId/assignmentId for inspection; items accepts cursor?; list includeArchived=1 optional.
- Success response schema: 200 {workers,teams,datasets,definitions:[{id,name,publishedVersion,versions:[{version,recordingsPerTask}]}]}.
- Additional errors: 400/404/422.
- [Authoritative handler](../app/api/v1/team-jobs/route.ts).

Representative request:

```http
GET /api/v1/team-jobs?action=catalog&projectId=00000000-0000-4000-8000-000000000001
```
## GET `/api/v1/team-jobs?action=items`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&datasetId=00000000-0000-4000-8000-000000000002`; path parameters as above.
- Request schema: UUID project; jobId/assignmentId for inspection; items accepts cursor?; list includeArchived=1 optional.
- Success response schema: 200 {items:AllocationItem[],nextCursor:string|null}.
- Additional errors: 400/404/422.
- [Authoritative handler](../app/api/v1/team-jobs/route.ts).

Representative request:

```http
GET /api/v1/team-jobs?action=items&projectId=00000000-0000-4000-8000-000000000001&datasetId=00000000-0000-4000-8000-000000000002
```
## GET `/api/v1/team-jobs?action=detail`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&jobId=00000000-0000-4000-8000-000000000007`; path parameters as above.
- Request schema: UUID project; jobId/assignmentId for inspection; items accepts cursor?; list includeArchived=1 optional.
- Success response schema: 200 {summary:JobSummary,plan:JobPlan,workerProgress,assignments}.
- Additional errors: 400/404/422.
- [Authoritative handler](../app/api/v1/team-jobs/route.ts).

Representative request:

```http
GET /api/v1/team-jobs?action=detail&projectId=00000000-0000-4000-8000-000000000001&jobId=00000000-0000-4000-8000-000000000007
```
## GET `/api/v1/team-jobs?action=results`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&jobId=00000000-0000-4000-8000-000000000007`; path parameters as above.
- Request schema: UUID project; jobId/assignmentId for inspection; items accepts cursor?; list includeArchived=1 optional.
- Success response schema: 200 JobResults (audiolab.analytics/2; completion-gated).
- Additional errors: 400/404/422.
- [Authoritative handler](../app/api/v1/team-jobs/route.ts).

Representative request:

```http
GET /api/v1/team-jobs?action=results&projectId=00000000-0000-4000-8000-000000000001&jobId=00000000-0000-4000-8000-000000000007
```
## GET `/api/v1/team-jobs?action=task`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&jobId=00000000-0000-4000-8000-000000000007&assignmentId=00000000-0000-4000-8000-000000000006`; path parameters as above.
- Request schema: UUID project; jobId/assignmentId for inspection; items accepts cursor?; list includeArchived=1 optional.
- Success response schema: 200 {assignment,taskInstance:TaskInstancePreview,current}.
- Additional errors: 400/404/422.
- [Authoritative handler](../app/api/v1/team-jobs/route.ts).

Representative request:

```http
GET /api/v1/team-jobs?action=task&projectId=00000000-0000-4000-8000-000000000001&jobId=00000000-0000-4000-8000-000000000007&assignmentId=00000000-0000-4000-8000-000000000006
```
## POST `/api/v1/team-jobs?action=preview`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: jobInputSchema; item/worker/version/resource eligibility checked — `jobInputSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 200 {plan:JobPlan}; no assignments persisted.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/team-jobs/route.ts).

Representative request:

```http
POST /api/v1/team-jobs?action=preview
```

```json
{
  "jobId": "00000000-0000-4000-8000-000000000007",
  "projectId": "00000000-0000-4000-8000-000000000001",
  "name": "Synthetic job",
  "datasetId": "00000000-0000-4000-8000-000000000002",
  "definitionId": "00000000-0000-4000-8000-000000000004",
  "definitionVersion": 1,
  "mode": "voting",
  "seed": "example-v1",
  "itemKeys": [
    "SOURCE_ITEM_KEY"
  ],
  "workerIds": [
    "example-worker",
    "example-worker-b"
  ],
  "sampleCount": 1
}
```
## POST `/api/v1/team-jobs?action=launch`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: jobInputSchema + expectedHash:string from exact preview; use plan.input.
- Success response schema: 200 JobDetail {summary,plan,assignments,workerProgress}; replay of same launched plan is idempotent.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/team-jobs/route.ts).

Representative request:

```http
POST /api/v1/team-jobs?action=launch
```

```json
{
  "jobId": "00000000-0000-4000-8000-000000000007",
  "projectId": "00000000-0000-4000-8000-000000000001",
  "name": "Synthetic job",
  "datasetId": "00000000-0000-4000-8000-000000000002",
  "definitionId": "00000000-0000-4000-8000-000000000004",
  "definitionVersion": 1,
  "mode": "voting",
  "seed": "example-v1",
  "itemKeys": [
    "SOURCE_ITEM_KEY"
  ],
  "workerIds": [
    "example-worker",
    "example-worker-b"
  ],
  "sampleCount": 1,
  "expectedHash": "EXACT_PREVIEW_HASH"
}
```
## POST `/api/v1/team-jobs?action=delete`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: {projectId:UUID,jobId:UUID}.
- Success response schema: 200 {deleted:true,historyPreserved:true}; archive; assignments read-only.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/team-jobs/route.ts).

Representative request:

```http
POST /api/v1/team-jobs?action=delete
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "jobId": "00000000-0000-4000-8000-000000000007"
}
```
## GET `/api/v1/assignments`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001`; path parameters as above.
- Request schema: projectId UUID; labellerId? filter.
- Success response schema: 200 {assignments:AssignmentSummary[]}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/assignments/route.ts).

Representative request:

```http
GET /api/v1/assignments?projectId=00000000-0000-4000-8000-000000000001
```
## POST `/api/v1/assignments`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: createAssignmentSchema — `createAssignmentSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 201 {assignment:Assignment}; idempotent natural identity.
- Additional errors: 400/404/409.
- [Authoritative handler](../app/api/v1/assignments/route.ts).

Representative request:

```http
POST /api/v1/assignments
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "taskInstanceId": "00000000-0000-4000-8000-000000000005",
  "labellerId": "example-worker"
}
```
## GET `/api/v1/assignments/{id}`

- Integration: production.
- Authentication/permission: Project admin or assigned owner.
- Parameters: `none`; path parameters as above.
- Request schema: id UUID.
- Success response schema: 200 {assignment,taskInstance:TaskInstancePreview}.
- Additional errors: 400/404/422.
- [Authoritative handler](../app/api/v1/assignments/[id]/route.ts).

Representative request:

```http
GET /api/v1/assignments/{id}
```
## POST `/api/v1/assignments/{id}/start`

- Integration: production.
- Authentication/permission: Authenticated assigned owner; labellerId must equal verified userId (admin role does not grant impersonation).
- Parameters: `none`; path parameters as above.
- Request schema: startAssignmentSchema — `startAssignmentSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 200 {assignment:Assignment}.
- Additional errors: 400/404/409/410.
- [Authoritative handler](../app/api/v1/assignments/[id]/start/route.ts).

Representative request:

```http
POST /api/v1/assignments/{id}/start
```

```json
{
  "labellerId": "example-worker"
}
```
## GET `/api/v1/assignments/{id}/annotation`

- Integration: production.
- Authentication/permission: Authenticated assigned owner; labellerId must equal verified userId (admin role does not grant impersonation).
- Parameters: `labellerId=SESSION_USER_ID`; path parameters as above.
- Request schema: id UUID; own labellerId string <=128.
- Success response schema: 200 {assignmentId,current:AnnotationRevision|null}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/assignments/[id]/annotation/route.ts).

Representative request:

```http
GET /api/v1/assignments/{id}/annotation?labellerId=SESSION_USER_ID
```
## GET `/api/v1/assignments/{id}/annotation/revisions`

- Integration: production.
- Authentication/permission: Authenticated assigned owner; labellerId must equal verified userId (admin role does not grant impersonation).
- Parameters: `labellerId=SESSION_USER_ID`; path parameters as above.
- Request schema: id UUID; own labellerId.
- Success response schema: 200 {revisions:AnnotationRevision[]}; immutable history.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/assignments/[id]/annotation/revisions/route.ts).

Representative request:

```http
GET /api/v1/assignments/{id}/annotation/revisions?labellerId=SESSION_USER_ID
```
## POST `/api/v1/assignments/{id}/annotation/draft`

- Integration: production.
- Authentication/permission: Authenticated assigned owner; labellerId must equal verified userId (admin role does not grant impersonation).
- Parameters: `none`; path parameters as above.
- Request schema: annotationWriteSchema; values checked against resolved pinned blocks; submit requires required visible answers — `annotationWriteSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 201 {annotation:AnnotationRevision}.
- Additional errors: 400/404/409 stale or final/410 archived/422 invalid answers.
- [Authoritative handler](../app/api/v1/assignments/[id]/annotation/draft/route.ts).

Representative request:

```http
POST /api/v1/assignments/{id}/annotation/draft
```

```json
{
  "labellerId": "example-worker",
  "expectedRevision": 0,
  "answers": {
    "present": true
  }
}
```
## POST `/api/v1/assignments/{id}/annotation/submit`

- Integration: production.
- Authentication/permission: Authenticated assigned owner; labellerId must equal verified userId (admin role does not grant impersonation).
- Parameters: `none`; path parameters as above.
- Request schema: annotationWriteSchema; values checked against resolved pinned blocks; submit requires required visible answers — `annotationWriteSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 201 {annotation:AnnotationRevision}.
- Additional errors: 400/404/409 stale or final/410 archived/422 invalid answers.
- [Authoritative handler](../app/api/v1/assignments/[id]/annotation/submit/route.ts).

Representative request:

```http
POST /api/v1/assignments/{id}/annotation/submit
```

```json
{
  "labellerId": "example-worker",
  "expectedRevision": 0,
  "answers": {
    "present": true
  }
}
```
## GET `/api/v1/assignments/{id}/candidates`

- Integration: legacy compatibility.
- Authentication/permission: Authenticated assigned owner; labellerId must equal verified userId (admin role does not grant impersonation).
- Parameters: `labellerId=SESSION_USER_ID`; path parameters as above.
- Request schema: id UUID; own labellerId.
- Success response schema: 200 {candidateSets:Record<blockId,CandidateSetView>}; no private authors/tallies.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/assignments/[id]/candidates/route.ts).

Representative request:

```http
GET /api/v1/assignments/{id}/candidates?labellerId=SESSION_USER_ID
```
## GET `/api/v1/labeller/assigned-queue`

- Integration: production.
- Authentication/permission: Authenticated assigned owner; labellerId must equal verified userId (admin role does not grant impersonation).
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&labellerId=SESSION_USER_ID`; path parameters as above.
- Request schema: projectId,labellerId; queueJobId? UUID|standalone; cursor?<=1000; limit?1..50 default20.
- Success response schema: 200 {jobs,definition,requiredAudio,totalAudio,totalCompleteGroups,totalSubmitted,totalPending,remainderAudio,groups,nextCursor}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/labeller/assigned-queue/route.ts).

Representative request:

```http
GET /api/v1/labeller/assigned-queue?projectId=00000000-0000-4000-8000-000000000001&labellerId=SESSION_USER_ID
```
## GET `/api/v1/labeller/overview`

- Integration: production.
- Authentication/permission: Authenticated assigned owner; labellerId must equal verified userId (admin role does not grant impersonation).
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&labellerId=SESSION_USER_ID`; path parameters as above.
- Request schema: projectId UUID and own labellerId.
- Success response schema: 200 {counts:{total,assigned,inProgress,submitted,reviewed,drafts},recent}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/labeller/overview/route.ts).

Representative request:

```http
GET /api/v1/labeller/overview?projectId=00000000-0000-4000-8000-000000000001&labellerId=SESSION_USER_ID
```
## GET `/api/v1/labeller/queue`

- Integration: production.
- Authentication/permission: Authenticated assigned owner; labellerId must equal verified userId (admin role does not grant impersonation).
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&labellerId=SESSION_USER_ID`; path parameters as above.
- Request schema: projectId UUID and own labellerId.
- Success response schema: 200 {assignments:AssignmentSummary[]}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/labeller/queue/route.ts).

Representative request:

```http
GET /api/v1/labeller/queue?projectId=00000000-0000-4000-8000-000000000001&labellerId=SESSION_USER_ID
```
## GET `/api/v1/labeller/queue/page`

- Integration: production.
- Authentication/permission: Authenticated assigned owner; labellerId must equal verified userId (admin role does not grant impersonation).
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&labellerId=SESSION_USER_ID`; path parameters as above.
- Request schema: projectId UUID, own labellerId; limit?1..50 default20; opaque cursor?.
- Success response schema: 200 {assignments,hasMore,nextCursor}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/labeller/queue/page/route.ts).

Representative request:

```http
GET /api/v1/labeller/queue/page?projectId=00000000-0000-4000-8000-000000000001&labellerId=SESSION_USER_ID
```
## GET `/api/v1/research-overview`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001`; path parameters as above.
- Request schema: projectId is authorized context; aggregates only admin memberships.
- Success response schema: 200 ResearchOverview: {asOf,scope:admin-projects,projects,totals}.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/research-overview/route.ts).

Representative request:

```http
GET /api/v1/research-overview?projectId=00000000-0000-4000-8000-000000000001
```
## GET `/api/v1/research-export`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&jobId=00000000-0000-4000-8000-000000000007&format=json`; path parameters as above.
- Request schema: projectId/jobId UUID; format? preview(default)|json|audio-json|json-zip|audio-zip; audioId UUID required for audio-json.
- Success response schema: 200 ResearchExport, per-audio JSON or application/zip; download headers by format.
- Additional errors: 400/404/413 JSON32MiB/archive256MiB/422 no finals.
- [Authoritative handler](../app/api/v1/research-export/route.ts).

Representative request:

```http
GET /api/v1/research-export?projectId=00000000-0000-4000-8000-000000000001&jobId=00000000-0000-4000-8000-000000000007&format=json
```
## GET `/api/v1/assignment-allocation`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&adminId=SESSION_USER_ID&datasetId=00000000-0000-4000-8000-000000000002`; path parameters as above.
- Request schema: projectId,datasetId UUID; exact adminId; cursor?<=1000.
- Success response schema: 200 {items:AllocationItem[],hasMore:boolean,nextCursor:string|null}; page <=100.
- Additional errors: 400/404.
- [Authoritative handler](../app/api/v1/assignment-allocation/route.ts).

Representative request:

```http
GET /api/v1/assignment-allocation?projectId=00000000-0000-4000-8000-000000000001&adminId=SESSION_USER_ID&datasetId=00000000-0000-4000-8000-000000000002
```
## POST `/api/v1/assignment-allocation?action=preview`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: allocationSchema; <=128 KiB; prefer team-jobs for exportable release studies — `allocationSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 200 {preview:{items,pairs,uniqueItems,assignments,newAssignments,perWorker}}.
- Additional errors: 400/404/409/413/422.
- [Authoritative handler](../app/api/v1/assignment-allocation/route.ts).

Representative request:

```http
POST /api/v1/assignment-allocation?action=preview
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "adminId": "example-admin",
  "datasetId": "00000000-0000-4000-8000-000000000002",
  "definitionId": "00000000-0000-4000-8000-000000000004",
  "definitionVersion": 1,
  "itemKeys": [
    "SOURCE_ITEM_KEY"
  ],
  "labellerIds": [
    "example-worker"
  ],
  "independentLabellers": 1,
  "mode": "fixed"
}
```
## POST `/api/v1/assignment-allocation?action=confirm`

- Integration: production.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: confirmAllocationSchema; revalidate exact reviewed pairs — `confirmAllocationSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 200 {result:{uniqueItems,assignments,created,alreadyAssigned}}.
- Additional errors: 400/404/409/413/422.
- [Authoritative handler](../app/api/v1/assignment-allocation/route.ts).

Representative request:

```http
POST /api/v1/assignment-allocation?action=confirm
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "adminId": "example-admin",
  "datasetId": "00000000-0000-4000-8000-000000000002",
  "definitionId": "00000000-0000-4000-8000-000000000004",
  "definitionVersion": 1,
  "itemKeys": [
    "SOURCE_ITEM_KEY"
  ],
  "labellerIds": [
    "example-worker"
  ],
  "independentLabellers": 1,
  "mode": "fixed",
  "pairs": [
    {
      "itemKey": "SOURCE_ITEM_KEY",
      "labellerId": "example-worker"
    }
  ]
}
```
## POST `/api/v1/candidate-sets`

- Integration: legacy compatibility; not new authoring.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: createCandidateSetSchema; immutable source references — `createCandidateSetSchema` in [generated request schemas](api/request-schemas.json)..
- Success response schema: 200/201 {candidateSet:CandidateSetView}.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/candidate-sets/route.ts).

Representative request:

```http
POST /api/v1/candidate-sets
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "taskInstanceId": "00000000-0000-4000-8000-000000000005",
  "blockId": "legacy-vote",
  "userId": "example-admin",
  "requestId": "example-idempotency",
  "sources": [
    {
      "kind": "submission",
      "revisionId": "00000000-0000-4000-8000-000000000006",
      "blockId": "text"
    },
    {
      "kind": "submission",
      "revisionId": "00000000-0000-4000-8000-000000000007",
      "blockId": "text"
    }
  ]
}
```
## GET `/api/v1/candidate-sets/sources`

- Integration: legacy compatibility; not new authoring.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&userId=SESSION_USER_ID&taskInstanceId=00000000-0000-4000-8000-000000000005&blockId=legacy-vote`; path parameters as above.
- Request schema: own actor/task scope and eligibility; blockId string 1..80.
- Success response schema: 200 {sources:CandidateSourceOption[],candidateSet:CandidateSetView|null}; private admin curation inventory.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/candidate-sets/sources/route.ts).

Representative request:

```http
GET /api/v1/candidate-sets/sources?projectId=00000000-0000-4000-8000-000000000001&userId=SESSION_USER_ID&taskInstanceId=00000000-0000-4000-8000-000000000005&blockId=legacy-vote
```
## GET `/api/v1/candidate-sets/{id}/result`

- Integration: legacy compatibility; not new authoring.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `projectId=00000000-0000-4000-8000-000000000001&userId=SESSION_USER_ID`; path parameters as above.
- Request schema: id set UUID and actor query.
- Success response schema: 200 {result:CandidateResult}.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/candidate-sets/[id]/result/route.ts).

Representative request:

```http
GET /api/v1/candidate-sets/{id}/result?projectId=00000000-0000-4000-8000-000000000001&userId=SESSION_USER_ID
```
## POST `/api/v1/candidate-sets/{id}/result`

- Integration: legacy compatibility; not new authoring.
- Authentication/permission: Authenticated project administrator; resource project is resolved server-side.
- Parameters: `none`; path parameters as above.
- Request schema: {projectId:UUID,userId:own actor}.
- Success response schema: 200 {result:CandidateResult}; existing immutable finalization.
- Additional errors: 400/404/409/422.
- [Authoritative handler](../app/api/v1/candidate-sets/[id]/result/route.ts).

Representative request:

```http
POST /api/v1/candidate-sets/{id}/result
```

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "userId": "example-admin"
}
```

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
