# Authentication and account administration

AudioLab uses Cloudflare Access for production human identity, with explicit
AudioLab account links and D1 project roles. There is no public signup or
production password login. Local DEV login remains available only when explicitly
selected on loopback. See [deployment](DEPLOYMENT.md),
[fresh local setup](22_FRESH_LOCAL_SETUP.md) and the
[API permission reference](API.md).

## Request boundary

`proxy.ts` covers `/api/:path*`. `lib/backend/auth/api-guard.ts` permits only
explicit route/method policies, authenticates before resource access, compares
legacy actor assertions to the session and resolves resource ownership from D1.
Admin navigation and supplied IDs do not grant permission. A user can have roles
in several projects; admin in one does not imply access to another. An existing
project admin can create a new project and receives its membership atomically.
The first admin is a controlled operator provisioning operation.

`lib/backend/auth/identity.ts` validates:

- Exact configured HTTPS `APP_ORIGIN`; alternate Worker hostnames are rejected.
  No forwarded-host header selects an origin or identity provider.
- RS256 signature against the configured team domain's Access certs endpoint,
  exact issuer and application audience, required subject/issuance/expiry claims,
  not-before when present, and issuance age. Clock tolerance is 5 seconds.
- Application token `type:app`, nonempty human subject and a positive lifetime
  of at most 24 hours. Configure the Access application session duration **at most
  24 hours**. Global `org` tokens and service-token `common_name` identities are
  rejected. Signing keys can rotate through the existing remote JWKS resolver.
- Explicit `(issuer,subject)` → `auth_accounts.user_id` in
  `auth_identity_links`, active account and D1 project role. Email, display name,
  group claims, browser role toggles and claimed `userId` never create a link.
- SHA-256 token revocation digests. The full bearer token is not stored in D1.

This follows Cloudflare's [origin token validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
and [application-token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).
Cloudflare documents an empty `sub` for service tokens. The v1 CLI therefore uses
human application tokens instead of adding an unreviewed machine-to-admin mapping.

API writes require the exact canonical `Origin`; cross-site fetches are denied.
The CLI sends that Origin too. Browser CORS permission is not granted. Body bytes
are bounded before parsing (512 KiB ordinary API requests; 11 MiB multipart
envelope, with the existing 10 MiB WAV limit). Individual ingestion/export/annotation
contracts retain their stricter limits.

Protect the complete canonical hostname with Access, including `/api/*`, and do
not use Bypass rules to make the CLI work. Disable public R2 domains, alternate
Worker routes and preview URLs. Default custom-domain configuration disables
workers.dev; the explicit [staging workers.dev mode](DEPLOYMENT.md#workersdev-staging-without-a-purchased-domain)
requires Worker-level Access All traffic and a pinned origin. Previews remain off; API origin/JWT checks remain defense in depth. Static JavaScript
and the application shell contain no account credentials or research answers.

## Session discovery and logout

`GET /api/v1/auth/session` is public discovery: unauthenticated responses use
HTTP 200 with `user:null`, empty memberships, a sanitized error/status and a
validated login URL (or null). `configured:false` means operator action is needed.
Protected resource APIs use 401/403; unavailable mandatory configuration/schema
fails closed with 503. The UI refreshes session discovery on focus and every
60 seconds, removing the previous user's application tree when identity expires.

Production browser sessions use Access's `CF_Authorization` cookie. Configure
Secure HTTPS and HttpOnly in Access; verify the selected SameSite policy with the
IdP redirect flow. AudioLab also enforces same-origin writes, independently of
cookie policy. Cookie behavior is owned by [Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/),
not a new AudioLab password/session service.

`POST /api/v1/auth/logout` revokes that exact application JWT by digest for
24 hours, covering the maximum accepted lifetime. The UI then navigates to
`/cdn-cgi/access/logout` so Access clears its session. This does not promise a
global logout at the upstream IdP. Other issued tokens remain usable until
revoked/expired; set `auth_accounts.active=0` to revoke **all** application access
for an account immediately. Borrowed CLI tokens are never logged out on exit.
If an account is already inactive/its token revoked, use the Access logout URL
directly and contact the operator; do not reactivate it to make logout succeed.

## First production administrator

Requires an authorized Cloudflare/D1 operator, migrated **new** database, Access
application and verified human subject. Do not run `init_local.py` against remote
state: it deliberately provisions only local DEV credentials. No password or
shared seed account is needed for production.

1. Obtain the user's exact Access subject from trusted Access user records or a
   cryptographically verified application token for the configured issuer/audience.
   Decoding an unverified JWT or trusting an email is insufficient. A user removed
   and re-added to Zero Trust can receive a different subject; review relinking.
2. Generate two fresh UUIDs with `python -c 'import uuid; print(uuid.uuid4())'`:
   account and project. Copy `docs/examples/access-provisioning.json` to a private
   directory, chmod 600, replace every placeholder with the verified values and
   repeat the same UUIDs in its membership. Keep `bootstrap:true` only for first
   setup. This is trusted operator input, never an invitation from a browser.
3. Generate a private, parameter-bound batch for review:

   ```sh
   python scripts/provision_access.py --manifest /private/path/first-admin.json \
     --output /private/path/first-admin.batch.json
   ```

4. Review the exact account, subject, project, role and target database. The script
   makes **no network/database calls**. Only after deployment approval, apply the
   reviewed batch with the installed CLI:

   ```sh
   pnpm exec cf d1 raw "$AUDIOLAB_D1_ID" \
     --batch @/private/path/first-admin.batch.json
   ```

Without `--local` this is a **remote write**. This guide is not authorization to
run it. For disposable rehearsals use `--local --persist-to EXACT_DISPOSABLE_ROOT`
and the matching local DB ID instead. The installed cf supports local batches
through `d1 raw`; `d1 query --local` has no local equivalent. Never remove
`--local` to work around that error. Never target preserved research state.

The generated batch asserts preconditions, then creates existing-model accounts,
links, project and membership. Accounts have no demo password. Conflicting subjects,
usernames, roles, inactive accounts or unrelated bootstrap state abort rather than
overwrite. Exact replays are idempotent. Assertions/writes must remain in **one
batch**; do not execute individual statements. The same batch was exercised with
real disposable D1, including rollback on a late failure.

## Subsequent accounts, memberships and recovery

For another administrator/labeller, use the same envelope without `bootstrap` and
without `project` for an existing project. Declare its exact `projectId` and role.
`mode:create` needs a fresh UUID and cannot adopt legacy memberships lacking an
account. `mode:link` requires an existing active account with matching username and
display name, permitting a reviewed historical account to acquire an explicit
Access link. No existing identity link is silently reassigned and roles are not
changed by replaying a different manifest. A new project is usually created by an
authenticated admin in Project Configuration instead.

Authenticated admins can grant project membership through
`POST /api/v1/project-members` to an existing active account linked to the configured
issuer. This is membership management, not account registration. Worker profiles
and teams remain separate eligibility metadata. A project member without an active
linked account cannot sign in; profile `active` and account `active` have different
purposes. Use account deactivation for authentication revocation.

For a confirmed compromised account, an authorized operator can use:

```sh
pnpm exec cf d1 raw "$AUDIOLAB_D1_ID" \
  --sql 'UPDATE auth_accounts SET active=0 WHERE user_id=?' --params "$ACCOUNT_ID"
```

This is a remote administrative write requiring approval and an exact account ID.
Do not delete annotation revisions, reset passwords, recycle user IDs, or grant
another person the old subject. Recovery requires an independently verified new
Access identity, reviewed account linkage/reactivation and audit of existing links.
Remove obsolete links in a reviewed D1 administration batch only after confirming
they are no longer trusted. Cloudflare operator access, not a public recovery API,
is the break-glass path; keep at least two separately controlled administrators.

## Batch labeller operations: local and Cloudflare

These are existing operator CLIs, not a dashboard invitation feature. Dataset
imports are also CLI-based. Initial human OTP cannot be replaced by an invented
subject, reused demo password or a service token. After identity verification,
account and membership writes are automated and replayable. Do not invite a
labeller into the Cloudflare infrastructure account.

### Local username and password accounts

**Terminal:** select the exact local state root/project from
[local setup](22_FRESH_LOCAL_SETUP.md). Use the strict
[labellers manifest](examples/labellers.json); replace the fictional profiles with
your own list. It supports 1–200 entries with required `username` and
`display_name`; optional `user_id`, `country`, `profession`, `languages`,
`experience_years`, `active` and text `metadata`. Passwords/roles are not accepted
in that manifest. Multiple `--project-id` flags add the same identities to more
than one project.

```sh
python scripts/import_labellers.py --state-root "$AUDIOLAB_LOCAL_STATE" \
  --manifest /private/path/labellers.json --project-id "$PROJECT_ID" --dry-run
# Stop only the server using this exact root before applying:
python scripts/import_labellers.py --state-root "$AUDIOLAB_LOCAL_STATE" \
  --manifest /private/path/labellers.json --project-id "$PROJECT_ID" \
  --credentials-out "$WORK/new-labellers-private.json" --import --server-stopped
```

The importer backs up the local D1 before its transaction and generates private
passwords for new accounts only. It creates accounts, labeller memberships and
profiles without resetting existing credentials or submitted work. Retain the
original credential file; a replay does not reissue existing passwords. A changed
profile needs deliberate `--update-profiles`. Restart the same state root with
`AUTH_MODE=demo` via the documented `AUDIOLAB_AUTH_MODE=demo` startup setting.
Labellers use the generated username/password at the local login page.

### Cloudflare email OTP accounts

Load the private deployment environment and sign in with the **management cf
CLI** as described in [deployment](DEPLOYMENT.md). `PROJECT_ID` is the existing
AudioLab project UUID; `ACCESS_APP_ID` is the selected Worker-level Access app ID.
Use a private operator directory outside Git:

```sh
umask 077
OPS=/absolute/path/to/new-private-operator-directory
export OPS PROJECT_ID
mkdir -p "$OPS"
```

**Cloudflare dashboard or management CLI:** add each individual email to the
existing application's Allow policy. In the dashboard use Zero Trust → Access
controls → Applications → the staging Worker app → its Allow policy → individual
Emails. Retain Worker **All traffic**, OTP-only IdP, current administrator and all
other intended addresses. No Everyone/domain-wide rule, Bypass or Cloudflare
account membership is needed.

The same configuration can be applied from a reviewed private JSON request using
the installed CLI (a real remote policy write):

```sh
./node_modules/.bin/cf zero-trust access applications get "$ACCESS_APP_ID" \
  > "$OPS/access-app-before.json"
# Review a private application-update request retaining the existing Worker
# destination, IdP, cookies/session settings and complete intended email roster.
./node_modules/.bin/cf zero-trust access applications update "$ACCESS_APP_ID" \
  --body @"$OPS/access-app-request.json" --dry-run
# Apply only the reviewed request, then re-read it:
./node_modules/.bin/cf zero-trust access applications update "$ACCESS_APP_ID" \
  --body @"$OPS/access-app-request.json"
./node_modules/.bin/cf zero-trust access applications get "$ACCESS_APP_ID" \
  > "$OPS/access-app-after.json"
```

The request format is the same Worker-level application configuration in
[deployment](DEPLOYMENT.md#verified-cli-bootstrap-for-a-new-workersdev-worker):
`type:self_hosted`, `destinations:[{type:worker,worker_id:ACTUAL_ID}]`, actual
`allowed_idps`, `session_duration:1h`, HttpOnly, SameSite Lax,
`enable_binding_cookie:false`, and an Allow `policies` array containing exact
`include:[{email:{email:ADDRESS}}, ...]` rules. Use actual existing values, not
these descriptive placeholders. Do not blindly resubmit read-only API response
fields or replace a policy containing other requirements with a simplified one.
Application updates can alter security settings: the dashboard is the safer
choice unless you already maintain a reviewed request file.

**Person:** visit the canonical AudioLab HTTPS origin in a separate browser
session and complete OTP for their allowlisted email. Before provisioning,
Access can authenticate them while AudioLab correctly reports no linked account.

**Terminal:** query the trusted management API, rather than decoding an unverified
JWT or guessing a subject from an email:

```sh
EMAIL=listener@example.org
export EMAIL
./node_modules/.bin/cf zero-trust access users list --email "$EMAIL" \
  > "$OPS/access-user.json"
```

Confirm exactly one matching email, a nonempty `uid`/`id` and successful login in
this deployment's Cloudflare account. In the accepted deployment, both trusted
user-record IDs matched the cryptographically verified JWT `sub` for the two
initial identities. Subjects are account-specific and can change after deletion/
recreation; never match solely by display name. See Cloudflare's
[application-token subject semantics](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

Create the private provisioning manifest once; retain it for exact retries:

```sh
python - <<'PY_ACCOUNT'
import json, os, uuid
from pathlib import Path
ops = Path(os.environ["OPS"])
users = json.loads((ops / "access-user.json").read_text())
if not isinstance(users, list):
    raise ValueError("Expected the installed cf user's JSON array")
matches = [u for u in users if u.get("email") == os.environ["EMAIL"]]
if len(matches) != 1 or not matches[0].get("last_successful_login"):
    raise ValueError("Verify one authenticated user in the correct account")
subject = matches[0].get("uid") or matches[0].get("id")
if not subject:
    raise ValueError("Missing trusted Access subject")
user_id = str(uuid.uuid4())
manifest = {
    "issuer": os.environ["ACCESS_TEAM_DOMAIN"],
    "accounts": [{"mode": "create", "userId": user_id,
                  "username": "listener-one", "displayName": "Listener One",
                  "subject": subject}],
    "memberships": [{"projectId": os.environ["PROJECT_ID"],
                     "userId": user_id, "role": "labeller"}]
}
fd = os.open(ops / "new-labellers.json", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, "w") as output:
    json.dump(manifest, output, indent=2)
PY_ACCOUNT
python scripts/provision_access.py --manifest "$OPS/new-labellers.json" \
  --output "$OPS/new-labellers.batch.json"
# Review identities, labeller roles, project UUID and explicit target database:
./node_modules/.bin/cf d1 raw "$AUDIOLAB_D1_ID" \
  --batch @"$OPS/new-labellers.batch.json"
```

This creates an active account, exact issuer/subject link and project membership
with no password. For a batch, include 1–50 distinct accounts and up to 100
explicit memberships in the same envelope, reusing each generated `userId` in its
memberships. Omit `bootstrap` and `project` for existing projects. `mode:link`
adds memberships to a reviewed existing active account without assigning someone
else's old identity. The SQL-batch generator makes no cloud call; only `cf d1 raw`
applies it. A failed/retried batch must reuse the same IDs/subjects; do not generate
new UUIDs for the same username each time. Existing batch output is preserved;
apply the reviewed file again or generate into a new private filename.

**AudioLab UI:** refresh the project, open Team & assignments, edit the labeller's
profile if needed, create/select a team containing that active account-ready
labeller, select dataset and published Task Definition, preview allocation and
confirm. Team membership alone creates no assignments. The labeller signs in
with OTP and opens Workspace → Assigned job. New one-person work has no
inter-annotator comparison pairs. See the [walkthrough](WORKFLOW.md).

### Revoke access without deleting research

For cloud access, remove the individual email from the Access Allow policy and
have an authorized operator set the exact AudioLab account's `active=0` using the
parameter-bound command above. Deactivation blocks already issued valid tokens
at the application boundary; policy removal alone should not be treated as
immediate application-token revocation. Do not remove shared administrators or
an entire IdP to revoke one labeller. Retain their stable ID and annotations.

Locally, the profile's `active:false` controls new-work eligibility, not account
login. To revoke login, stop the exact state-root server and use the existing
local cf D1 operation with its explicit UUID and persistence root:

```sh
AUDIOLAB_ENV=local AUDIOLAB_HOST_MODE=custom-domain \
  ./node_modules/.bin/cf d1 raw "$LOCAL_D1_ID" --local \
  --persist-to "$AUDIOLAB_LOCAL_STATE/v3" \
  --sql 'UPDATE auth_accounts SET active=0 WHERE user_id=?' --params "$ACCOUNT_ID"
```

The local initializer's `environment.json` records `databaseId`; use that actual
UUID for `LOCAL_D1_ID`. Back up first, then restart the same root. Do not delete
assignments/revisions, reuse another person's ID or reset passwords as revocation.

## Troubleshooting

- `configured:false` / 503: check exact HTTPS origin, issuer, audience, auth mode,
  binding names and migration history. Invalid config never falls back to demo.
- 401: expired/invalid/global token, wrong audience/issuer, revoked token or unlinked
  identity. Reauthenticate for the **application**, then verify the subject link.
- 403: inactive account, wrong project/role, actor spoof, another worker's assignment
  or invalid Origin. Do not change roles merely to suppress the failure.
- Identity changed: inspect issuer+subject in trusted Access records; email/name
  matching will not recover an account automatically.
- CLI redirect/HTML challenge: renew the application token, verify the canonical
  hostname and Access Allow policy. Do not enable redirects or TLS bypass.
- Alternate hostname: pin one canonical HTTPS origin; use the explicit staging
  host mode for workers.dev with verified Worker-level All traffic protection. Remove stale routes. A separate staging hostname needs its own origin/audience/resources.
- Database/storage errors: check `DB` / `AUDIO_BUCKET` bindings and the backend log;
  generic API errors do not expose SQL or private source payloads. Never reset an
  existing database to repair a missing migration.

Real email OTP, secure application cookies, explicit subject links, role isolation
and authenticated CLI behavior passed two-identity workers.dev staging acceptance.
Key rotation, extended expiry/recovery and three-labeller live acceptance remain
separate checks in the [live staging procedure](DEPLOYMENT.md#verify-the-deployed-instance). Isolated signed tokens are not proof
that an external Access policy has been configured correctly.
