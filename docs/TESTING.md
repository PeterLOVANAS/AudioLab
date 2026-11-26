# Testing and CI

Use Node 24, pnpm 11.25.0 and Python 3.11 with
`pip install -r scripts/requirements.txt`. No private dataset/cloud credential is
needed. Package scripts run from the repository root. A missing test/failure is
not silently skipped; the JavaScript runner includes every supported `test_*.cjs`
except the separately invoked built-Worker security suite.

```sh
pnpm install --frozen-lockfile
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install -r scripts/requirements.txt
pnpm run docs:check
pnpm run typecheck
pnpm run test:regressions
pnpm run test:python
pnpm run build
AUDIOLAB_TEST_PYTHON=python pnpm run test:production
node scripts/test_production_config.mjs
```

Typecheck first generates Vinext route helpers and Cloudflare binding types; do
not commit generated `.next`/`.cloudflare` content. The 35 offline CJS scripts use
in-memory/temporary SQLite, services/validators and rendering checks. They include
fresh and historical-order migration checks. The byte-pinned W01 compatibility
fixture is outside runtime migrations and needs no remote Git ref.

Five Python unit suites contain 37 tests for Access tooling, local API client,
canonical/adapters/retry planning, setup and account provisioning. The production
suite requires the build, OpenSSL and Python requests; it exercises actual routing,
RS256 identities, local D1/R2, HTTP/TLS ingestion, permission/privacy failures,
draft expiry and missing-audio recovery. Its signing authority/TLS CA are isolated
test material, not real Cloudflare Access evidence.

## Full persisted browser acceptance

Stop any process occupying **127.0.0.1:5202** yourself after identifying its owner.
The runner refuses a busy port and never stops an unrelated server. Choose either
installed Google Chrome (local default), or matching Playwright Chromium:

```sh
# CI and an optional local Chromium run:
pnpm exec playwright-core install --with-deps chromium
AUDIOLAB_BROWSER_CHANNEL=chromium pnpm run test:acceptance
# Local installed Chrome instead:
pnpm run test:acceptance
```

`scripts/ci_acceptance.py` creates a new private temporary `audiolab-r02b-*` root,
uses the actual initializer, canonical importer, admin/labeller provisioning,
Worker/D1/R2, all block fixtures, import interruption tests and a historical ballot
compatibility fixture. Playwright edits/publishes/allocates in the UI, annotates as
three independent workers, asserts exact intervals and IoUs, decodes/plays real
audio, reloads drafts, renders all results and downloads exports. Finally it
restarts the same server/root and compares persisted finals/analytics.

Only that runner's child is stopped; state is retained privately for diagnosis.
Do not upload the entire root: it contains passwords, sessions, source reports,
D1/R2 and downloads. No traces/HARs or credential screenshots are intentionally
recorded. Human audible output still needs manual QA.

## GitHub Actions

[ci.yml](../.github/workflows/ci.yml) uses Ubuntu 24.04, Node 24, Python 3.11,
the pinned package manager, frozen lockfile, pinned action commits and
`contents:read`. Checkout does not persist credentials. There is no deployment,
write/OIDC permission, live cloud secret or automatic artifact publication.

The checks job runs docs/types, all supported regressions, Python, build,
production HTTP/TLS and configuration tests. The browser job installs matching
Chromium and runs the same disposable acceptance command. Fork PRs use
`pull_request`, not privileged `pull_request_target`. Both hosted jobs passed for the staging release revision. Future documentation
or code changes still need checks on their exact proposed commit; prior green
checks do not establish that an uncommitted revision passed hosted Actions.

Historical lesson `*_http.py` scripts often require old unauthenticated seeded
fixtures. They are retained as internal/development utilities, not advertised as
the current release test entrypoint. The explicit new HTTP/browser workflow is
not a claim that every historical script passes against current auth.

## Manual acceptance

[Demonstration checklist](DEMONSTRATION.md) covers audible sound, real Access/IdP
cookies/expiry, staging and visual inspection. Live staging needs an approved
account/hostname, isolated D1/R2, linked identities, budget and cleanup/rollback
owner. Never run a remote deployment/migration as part of local tests.

## Batched question and aid regression

`node scripts/test_question_results.cjs` tests optional/required batched answers
in both validators, malformed intervals, question-local distributions, rank
position counts, reference ambiguity/privacy, training opt-in and real component
SSR. `node scripts/test_final_results.cjs` additionally persists four distinct
question/audio inputs, three independent finals with an omitted optional aid,
rankings, admin-only reference evaluation, exact export parity and explicitly
released training previews using disposable SQLite and the actual services.
These checks are automatically discovered by `pnpm run test:regressions`.
