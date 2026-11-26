# Cloudflare deployment

AudioLab uses the existing Vinext/Vite + Cloudflare Vite plugin **v2** + `cf`
configuration, not a conventional Next.js server or a newly added Wrangler
project. This runbook prepares a new environment; it is not authorization to
create resources, migrate remote data or deploy. Local, isolated production-mode
and actual workers.dev Cloudflare staging acceptance have passed. The live test
on 2026-11-26 covered one administrator and one labeller using real email OTP,
Workers/D1/private R2, HTTPS CLI import/retry, Chrome playback/annotation, results
and exports. It did not establish three-labeller live agreement, custom-domain
acceptance, sustained-load capacity, key rotation or disaster recovery.

For offline work use [fresh local setup](22_FRESH_LOCAL_SETUP.md). For accounts,
read [authentication](AUTHENTICATION.md); for data use
[canonical CLI ingestion](23_DATASET_INGESTION.md). Existing research stores must
never be reset or reused as disposable acceptance fixtures.

## Dependencies and configuration

Tested runtime: Node 24, the repository-declared `pnpm@11.25.0`, Python 3.11
(tooling requires 3.10+). Keep the lockfile and installed versions. If `pnpm` is not on PATH, use
`corepack pnpm` for the commands below; Corepack fetches the declared version.
This was verified with a temporary Corepack cache, without global installation.

```sh
pnpm install --frozen-lockfile
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install -r scripts/requirements.txt
```

The Cloudflare account must have Workers, D1, private R2 and the Images binding
available, a canonical HTTPS hostname, and a Zero Trust Access application/IdP.
Production/default custom-domain mode needs an active Cloudflare zone. Explicit
workers.dev staging mode below needs no purchased domain. Review the selected products' account permissions and pricing
before provisioning. Operator Cloudflare API credentials/profile need the minimum
permissions for the intended resource/deployment operations; user Access tokens
are **not** Cloudflare management API tokens.

Authenticate the existing **cf** CLI before resource operations:

```sh
AUDIOLAB_ENV=local AUDIOLAB_HOST_MODE=custom-domain ./node_modules/.bin/cf auth login
AUDIOLAB_ENV=local AUDIOLAB_HOST_MODE=custom-domain ./node_modules/.bin/cf auth whoami
```

On macOS, `cf auth login --use-keyring` was verified. Complete the browser grant
and Keychain prompt yourself. Inspect account identity privately; never print
credentials into shared logs. cf and Wrangler use separate credential stores;
this project does not require installing Wrangler to authorize deployment.
If pnpm is missing but Corepack exists, use `corepack pnpm --version` from the
repository, or enable its shim with `corepack enable pnpm` where permitted.
Do not update Node/dependencies merely to authenticate.

Activate R2 in the account dashboard before bucket creation. Review its usage
billing terms yourself. Included Standard allowances are not a spending cap,
and no paid Workers upgrade is required by this guide. The existing IMAGES
binding is retained; paid image transformation usage was not accepted here.

Copy `config/deployment.env.example` outside the repository, chmod 600 and fill
every value. Use distinct staging/production resources, hostname, audience and
Worker name. The file is shell-compatible; explicitly export its values:

```sh
set -a
. /private/path/audiolab-staging.env
set +a
```

Do not enable shell tracing, print tokens, or commit filled files. Keep
`CLOUDFLARE_ACCOUNT_ID` and the authorized Cloudflare API token/profile in the
operator's secure environment. They are not Worker bindings. No `VITE_`-prefixed
secrets and no plaintext research corpus in static assets.

| Setting/binding | Purpose |
| --- | --- |
| `AUDIOLAB_ENV` | `local`, `staging` or `production`; local is the default |
| `AUDIOLAB_WORKER_NAME` | Explicit environment-specific Worker name |
| `AUDIOLAB_AUTH_MODE` | Must be `access` for deployment |
| `APP_ORIGIN` | Exact canonical HTTPS origin, no path/trailing slash/port; workers.dev only in explicit staging mode |
| `AUDIOLAB_HOST_MODE` | `custom-domain` by default; `workers-dev` only with `AUDIOLAB_ENV=staging` |
| `AUDIOLAB_WORKERS_SUBDOMAIN` | Account workers.dev DNS label; required only in workers-dev mode |
| `AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED` | Literal `true` only after the operator verifies Worker-level Access All traffic; not automated cloud proof |
| `ACCESS_TEAM_DOMAIN` | Exact `https://TEAM.cloudflareaccess.com` issuer |
| `ACCESS_AUDIENCE` | That Access application's AUD tag; public configuration, not a secret |
| `AUDIOLAB_D1_ID`, `AUDIOLAB_D1_NAME` | Existing environment database UUID/name; local placeholder refused |
| `AUDIOLAB_R2_BUCKET` | Existing private bucket name; no public r2.dev/custom bucket domain |
| `DB`, `AUDIO_BUCKET` | Bound by `cloudflare.config.ts` to the values above |
| `ASSETS`, `IMAGES` | Existing generated static asset and Images bindings, retained |

`lib/config/deployment.ts` validates deployed settings without cloud calls.
`cloudflare.config.ts` keeps the literal local D1 declaration for the R01B
initializer, overriding it only for a validated deployed environment. Default
custom-domain mode keeps `workersDev:false` and sets `domains`. The explicit
staging mode enables only the canonical workers.dev route and omits `domains`.
`previewUrls:false` applies in both modes; no preview/version origin is allowed
by the API.
`vite.config.ts` retains opt-in `AUDIOLAB_LOCAL_STATE` for isolated **local** state;
it never makes bindings remote. Do not set it as a production data path.

This is the installed typed configuration model described by Cloudflare's
[cf configuration reference](https://developers.cloudflare.com/cf/projects/cloudflare-config/).
The matching [Vinext deployment guidance](https://github.com/cloudflare/vinext/blob/main/docs/getting-started/migrating-from-opennext.mdx)
uses `vinext-cloudflare deploy --env` for this stack. Do not replace it with
guessed `next start`, Pages, OpenNext or Wrangler commands.

## workers.dev staging without a purchased domain

This is an explicit staging-only option; production remains custom-domain-only.
Use the exact account subdomain from Workers & Pages (not an account ID):

```sh
AUDIOLAB_ENV=staging
AUDIOLAB_HOST_MODE=workers-dev
AUDIOLAB_WORKER_NAME=audiolab-v1-staging
AUDIOLAB_WORKERS_SUBDOMAIN=your-account-subdomain
APP_ORIGIN=https://audiolab-v1-staging.your-account-subdomain.workers.dev
# Set only after the dashboard verification below, not merely to pass preflight:
# AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED=true
```

Issuer/AUD and real D1/R2 settings are still mandatory. Worker/account labels must
match the entire origin exactly; other workers, accounts, preview/version prefixes,
ports, paths and lookalike suffixes fail. Remove workers-dev-only settings when
returning to custom-domain mode. `deploy --check` makes no cloud calls: the
confirmation is an **operator attestation**, not evidence that Access exists.

Before deploying AudioLab or seeding any data, perform these separately authorized
dashboard actions:

1. Enable Zero Trust for the selected account. Record its team issuer. In Workers
   & Pages, record the account's workers.dev subdomain.
2. Create/select the exact staging Worker with only Cloudflare's empty/default
   starter and no AudioLab research data/bindings. Do not import this repository
   or connect automatic deployments yet. In Settings > Domains & Routes disable
   the workers.dev route and preview URLs while configuring protection.
3. Open that Worker's **Access** tab > **Protect this Worker behind Access** >
   **All traffic** > configure the human Allow policy > **Apply Access**. Do not
   select Previews only or Make this Worker public. This must be Worker-level
   protection, not just a path/hostname rule or a broad account-wide change.
4. In Zero Trust > Access controls > Applications, edit the resulting app: select
   the intended IdP/approved email OTP and exact administrator/labeller
   roster (not a public email-domain Allow). Record its AUD and Worker identity.
   Set <=24 h sessions (one hour recommended), HttpOnly on, tested SameSite Lax,
   and Binding Cookie off for this release's non-browser CLI. Review/remove
   unintended more-specific Bypass policies. No service-token admin workaround.
5. Independently review All traffic and the exact Worker/account/application AUD.
   Only then set `AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED=true` in the private env.
   On the approved first deployment, inspect all public URL classes before account
   bootstrap/import; confirm anonymous requests to shell/assets/APIs challenge or
   deny. Stop on any bypass. Repeat after redeploy. The operator flag is never a
   substitute for this live acceptance.

[Official Worker-level Access setup](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
covers all associated hostnames; keep the app's own signed-JWT, identity-link,
project/assignment and exact-Origin checks unchanged. Vite Static Assets may not
provide `ctx.access`; AudioLab deliberately retains header/cookie JWT validation.
Disabling previews is not proof that every version/deployment URL is disabled;
inventory them and verify Access plus the API origin rejection on every alias.

The CLI keeps HTTPS, private origin-bound human tokens, no redirects/proxy
inheritance and TLS validation. No user-agent change has been made: a real
workers.dev Browser Integrity Check failure has not been reproduced. If an
importer gets edge error 1010, retain redacted evidence and review a descriptive
AudioLab user agent; do not spoof a browser, disable TLS or bypass Access.
[Cloudflare documents mandatory BIC on workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
Real email OTP, application cookies, signed identity linking, HTTPS CLI and
edge URL protection passed the two-identity staging test. Local tests alone
cannot simulate these managed services; repeat acceptance for each new account,
hostname, Access application and deployment configuration.

## Verified CLI bootstrap for a new workers.dev Worker

The pinned cf cannot upload a new version before a Worker exists. The staging
operator first deployed a minimal **unexposed** 503-only Worker, then configured
All traffic Access, and only then deployed AudioLab. Do not deploy the actual
application first just to obtain a Worker ID. This optional CLI alternative to
step 2 above creates a remote Worker; obtain the target account approval first.

```sh
export AUDIOLAB_WORKER_NAME=audiolab-v1-staging
PROJECT_ROOT="$PWD"
BOOTSTRAP="$(mktemp -d -t audiolab-bootstrap)"
export BOOTSTRAP
python3 - <<'PY_BOOT'
import json, os
from pathlib import Path
root = Path(os.environ["BOOTSTRAP"]) / ".cloudflare/output/v0"
worker = root / "workers/default"
(worker / "bundle").mkdir(parents=True)
(root / "config.json").write_text(json.dumps({"buildContext": {"isPreview": False, "mode": "production"}}))
(worker / "worker.config.json").write_text(json.dumps({
    "name": os.environ["AUDIOLAB_WORKER_NAME"],
    "compatibilityDate": "2026-10-26", "workersDev": False,
    "previewUrls": False, "env": {},
    "manifest": {"type": "partial", "mainModule": "index.js", "modules": {}}
}))
(worker / "bundle/index.js").write_text(
    'export default {fetch(){return new Response("Staging setup in progress",{status:503});}};'
)
PY_BOOT
(
  cd "$BOOTSTRAP"
  AUDIOLAB_ENV=local AUDIOLAB_HOST_MODE=custom-domain \
    "$PROJECT_ROOT/node_modules/.bin/cf" deploy --prebuilt
)
AUDIOLAB_ENV=local AUDIOLAB_HOST_MODE=custom-domain ./node_modules/.bin/cf workers list
```

Record the returned Worker ID privately. In Zero Trust create/select email OTP
and create the Worker-level app from step 3. Its API destination must be
`{"type":"worker","worker_id":"ACTUAL_WORKER_ID"}`. Select only the intended
OTP provider and individually allowlisted emails, then re-read the app and its
AUD. The verified cookie settings are one-hour session, HttpOnly, SameSite Lax
and binding cookie disabled. The application cookie is Secure; an organization
cookie may have different SameSite settings. No service-token policy or Bypass
is required. Finally re-read `cf workers list` and verify that the bootstrap's
workers.dev and preview routes are still disabled before the real deployment.

For a **custom domain**, use the existing default `custom-domain` host mode,
active Cloudflare zone, canonical HTTPS domain and hostname Access application.
Do not set workers.dev-only settings. The emitted Worker keeps `workersDev:false`
and `previewUrls:false`. That deployment path is configuration-tested; live
custom-domain/IdP acceptance must still be run separately.

## Prepare new infrastructure — explicit operator actions

First approve the target account, hostname mode, budget, resource names and data
location (and zone for custom-domain mode).
Configure the Cloudflare management credentials/profile. For **new** resources:

```sh
AUDIOLAB_ENV=local AUDIOLAB_HOST_MODE=custom-domain pnpm exec cf d1 create --name "$AUDIOLAB_D1_NAME"
AUDIOLAB_ENV=local AUDIOLAB_HOST_MODE=custom-domain pnpm exec cf r2 buckets create --name "$AUDIOLAB_R2_BUCKET"
```

These are **remote resource creation commands**. `AUDIOLAB_ENV=local` here merely
allows config evaluation before a real D1 ID exists; it does not simulate the
Cloudflare API command. Only the explicit `--local` CLI flag selects local D1
simulation. Capture the new database UUID privately, fill `AUDIOLAB_D1_ID`, then
reload the completed staging/production environment. Never substitute the example
UUID or point at an existing presentation database. R2 must stay private; audio
streams only through the authenticated Worker.

For custom-domain mode, configure the IdP and a self-hosted Access application
for the full canonical hostname, including APIs. For workers-dev mode complete
the Worker-level All traffic procedure above instead. Configure explicit human Allow policies, the
correct audience and session duration <=24 h. Set secure/HttpOnly cookie behavior
and verify IdP redirects. Do not create Bypass paths or service-token policies to
get around missing AudioLab account links. Disable any alternate legacy Worker
routes/custom domains; protect every intentionally supported hostname. The
application independently verifies signed JWTs and rejects alternate API origins.

Access management steps are external prerequisites for every fresh deployment.
The verified staging instance used a Worker-level `worker` destination, an OTP
provider and two individual email rules; its old account-wide `all_preview_workers`
rule did not protect production traffic. A `worker` destination protects All
traffic for the selected Worker without changing unrelated account-wide policy. See Cloudflare's
[web application setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
and [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## Initialize D1 and first admin

With the completed target environment and explicit authorization for remote writes:

```sh
pnpm exec cf d1 migrations list "$AUDIOLAB_D1_ID" --dir migrations
pnpm exec cf d1 migrations apply "$AUDIOLAB_D1_ID" --dir migrations
```

These commands identify D1 by **UUID**, not name or `DB`. Without `--local`, they
operate remotely. The installed cf uses `--dir`; no invented `--remote`, binding
selector or Wrangler config is required. On a fresh environment the current branch
has 16 migrations, 0001–0009 and 0011–0017. `0010_workflow_persistence.sql` is reserved
on the workflow branch; do not recreate it or infer missing tables from numbering.
Record the exact release revision and resulting `d1_migrations` history. Never
apply an unreviewed different branch's schema to a preserved store.

Provision the first production administrator with the private manifest/batch
procedure in [authentication](AUTHENTICATION.md#first-production-administrator).
It uses existing accounts, Access subject links and project membership, with no
demo password/public bootstrap endpoint. Generate/review the batch locally, then
explicitly apply it to the approved D1 UUID with `cf d1 raw --batch @FILE`.
Do not use the R01B local initializer on a remote database.

## Validate, build and deploy

The following preflight/build commands do not deploy or create resources:

```sh
pnpm run deploy --check
pnpm run typecheck
pnpm run build
pnpm exec vinext-cloudflare deploy --dry-run --env "$AUDIOLAB_ENV"
```

`deploy --check` validates explicit deployed settings and refuses local/demo or
placeholder configuration. The Vinext dry run validates framework/tool setup;
it is not a resource/Access/credential connectivity test. Vite produces
`.cloudflare/output/v0` with the bundled Worker/config/static assets. Inspect its
`workers/default/worker.config.json` before deployment: target Worker/domain, D1,
private R2, Access settings, `workersDev` true **only** for the explicitly gated
staging mode, `previewUrls:false`, `ASSETS` and `IMAGES`. Custom-domain mode must
have its exact `domains` entry; workers-dev mode must omit it. Output may contain environment resource identifiers; exclude build
output and filled configs from the source distribution.

After reviewing the concrete build/config, obtain deployment approval. Then:

```sh
pnpm run deploy
```

The wrapper invokes the installed `vinext-cloudflare deploy --env staging` or
`--env production` and rebuilds. It performs no migrations/account bootstrap.
Do not use `--skip-build` with an output compiled for another environment. Do not
deploy from a dirty/unreviewed release revision merely because local tests pass.
The sequence above was executed successfully for the isolated workers.dev staging
instance. Running it again is a live deployment, not a local verification command.

## Verify the deployed instance

Use a new staging project and only the bundled synthetic CC0 data:

1. Unauthenticated API requests receive the intended Access challenge/denial;
   authenticated but unlinked users have no AudioLab access. Check direct Worker
   and alternate hostnames. Do not mistake an HTML challenge for JSON API success.
2. Sign in as the explicitly linked first admin. Check session discovery and
   correct project membership, create another project and a dataset.
3. Acquire a human application token and run the documented
   [HTTPS CLI import](23_DATASET_INGESTION.md#production-https-access-commands),
   validation, inspection and exact retry. Confirm stable IDs and two stored WAVs.
4. Provision the approved independent labeller identities, publish a Task
   Definition with a matching vote count, bind source fields, preview/launch a
   job and annotate/draft/reload/submit as each user. Inspect progress/results
   and export; compare persisted answers and exported analytics. One labeller
   can verify the workflow but has zero inter-annotator pairs: agreement must
   be unavailable. A three-labeller claim requires three real linked labellers.
   Preserve older published protocols instead of reducing their vote counts.
5. Repeat unauthorized/cross-project/actor spoof/hidden-reference checks in the
   [API permission reference](API.md). Verify audio playback, range/seek behavior and browser layout.
6. Exercise token expiry, inactive accounts, revoked exact token, logout/IdP
   reauthentication, cookie flags, CSRF/Origin and signing-key rotation behavior.
   Capture redacted evidence; never record passwords/tokens in logs/screenshots.

The [isolated test](../scripts/test_production_security.cjs) already exercises the
built routing/proxy, RS256, real local D1/R2 and HTTPS Python importer with a test
authority. It does not verify actual Access-issued tokens, live D1/R2, DNS,
account permissions, policy configuration or browser/IdP behavior; the separate
live two-identity acceptance did exercise those services. Do not substitute its
result for acceptance of a different hostname, policy or account.

## Monitor resource consumption

In Workers & Pages, select the deployed Worker and open Metrics. Inspect request
counts, invocation status, CPU and wall time while exercising assignment loading,
audio, results and exports. Access-blocked requests need not invoke the Worker.
The GraphQL `workersInvocationsAdaptive` dataset exposes requests/errors and CPU
quantiles; its `cpuTimeP50`/`cpuTimeP99` values are **microseconds**, not milliseconds.
Dashboard/analytics aggregates can lag and are not a per-request profiler.
See [Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).

Workers Free has a 10 ms/request CPU budget and 100,000 requests/day. An accepted
small staging run does not guarantee capacity for large exports or many concurrent
labellers. Watch errors as well as quantiles; rollover flexibility can permit
occasional higher samples. No paid upgrade should occur without owner approval.
D1 Metrics shows rows read/written and storage. R2 Standard's included usage is
account-wide and monthly; review the billing dashboard rather than assuming a
small corpus can never incur charges. Management API object transfer uses R2/D1
operations directly and does not measure AudioLab Worker CPU.

A dataset CLI import is not a full research-state migration: it does not restore
old Task Instances, job allocations or Annotation Revisions. Such an operator
migration needs a reviewed scope, backup, disposable restore rehearsal, dependency
and hash checks, preserved IDs and immutable snapshots, plus a separate identity
plan. Never copy local demo credentials or a whole development state directory
into production. Historical attribution can remain inactive while separately
verified live identities receive explicit project memberships.

## Retention and approved cleanup

An ordinary owned Worker persists after the CLI exits; this runbook does not use
an expiring temporary account. Keep it running through the agreed recording or
study. Closing a browser or expiring an Access session does not delete drafts,
D1 or R2. Sign in again before recording if the one-hour session has expired.

Cleanup is a separate destructive operation requiring approval of exact resource
names/IDs and confirmation that recording/research retention requirements are met:

1. Export/back up approved results, D1 and required private R2 objects. Test the
   recovery artifacts; do not assume a Worker rollback restores its database.
2. Disable the intended Worker's public routes and previews while leaving Access
   protection in place. Stop new writes before removal.
3. In Workers & Pages, delete only the approved staging Worker. Never delete an
   account-wide Access rule to clean up a single application.
4. In R2, verify the approved bucket name, empty it only after backup/retention
   approval, then delete that bucket. Keep unrelated buckets and local data.
5. In D1, verify the exact staging UUID and delete only that database after backup
   approval. Time Travel/retention availability is plan-dependent.
6. Remove the corresponding Worker-level Access application when no longer used;
   remove its OTP provider only if it is not shared. Preserve account-wide Access,
   identity providers and resources used by other applications.
7. Recheck resource inventory/billing and hostname unavailability. Revoke only the
   staging credentials that are no longer needed; do not destroy local research
   environments or contributor history.

## Upgrades, backup and recovery

Before any later migration: identify the exact account/database/bucket and release
revision, stop/limit writes as appropriate, take a D1 backup/export or Time Travel
restore point, and back up R2 objects plus metadata using approved account tooling.
Record schema history and verify a restore on a separate approved environment.
Cloudflare documents [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/);
its retention is account-dependent and not a substitute for testing recovery.

Rehearse combined migration history on disposable data first. Apply only reviewed
pending migrations to the intended target; do not rename/replay recorded files.
Rolling back a Worker or switching Git branches does not roll back the database.
Preserve annotation revisions/identity IDs and imported original labels. Recovery
should restore a separate environment and reconcile writes deliberately rather
than resetting the live database. Dataset imports span separate durable writes;
use their private reports and identical retry procedure, not storage deletion.

## Troubleshooting

| Symptom | Check/action |
| --- | --- |
| DEV fails to load an existing auth/config module | Keep Node deployment preflight separate from Worker runtime imports with the installed CF Vite version; use the runtime/config separation already present in the source. |
| Deployment preflight fails | Fill the selected environment, exact HTTPS origin and real D1 ID; local/demo cannot deploy. |
| 503 / `configured:false` | Missing/invalid Access settings, binding/schema issue; inspect backend logs and migration history. No fallback to DEV login. |
| 401/unlinked identity | Correct application token/issuer/audience, expiry/revocation and exact active subject link. |
| 403 | Project role, assignment owner, actor assertion, Origin or inactive account; see authentication guide. |
| D1 missing table/column | Wrong binding or pending reviewed migrations; verify target/history before applying anything. Do not reset. |
| R2 object missing | Correct private bucket binding and partial-upload report; verify asset metadata/object pair before retry. |
| Migration failure | Stop, retain logs/backup, inspect committed migration history and SQL; no blind replay or new 0010. |
| CLI redirect/expiry | Renew an origin-bound human application credential; never follow redirects or disable TLS. |
| Unsupported import | PCM WAV/10 MiB, canonical v1 limits and immutable content rules remain; use the ingestion guide. |
| Alternate hostname | Remove stale routes, keep previews off, verify All traffic Access in workers-dev mode and exact APP_ORIGIN; do not widen origin checks. |
| workers-dev preflight rejection | Check staging-only host mode, exact Worker/account labels and real All traffic protection before the explicit confirmation. |
| workers.dev 1010 | Managed BIC may block generic library clients before Worker logs; retain evidence and review an honest app user agent. No Access/TLS bypass. |

Source licensing, contributor permission, reviewed public Git refs, exact-revision
hosted CI and final packaging remain release gates. Two-identity live Chrome
staging acceptance passed with synthetic data; audible sound still needs human
confirmation. Three-labeller live testing and broader load/recovery are separate
checks, not implied by successful deployment.
