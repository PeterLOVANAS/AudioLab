# Fresh local AudioLab setup

This initializes an independent **local development** installation without copied
presentation data. It does not deploy Cloudflare resources or configure a production
identity provider. Preserve any existing `.cloudflare/state`; never point these
commands at that store. Use the [canonical ingestion guide](23_DATASET_INGESTION.md)
after setup. See [testing](TESTING.md) for verified commands and limitations.

## Prerequisites

- Node 24 is the tested runtime; use the package manager declared in `package.json`
  (`pnpm@11.25.0`). Install repository dependencies with
  `pnpm install --frozen-lockfile`. Do not replace the lockfile or switch managers.
- Python **3.10+** with `venv` and pip. The release tooling is tested in a clean
  Python 3.11 virtual environment with `scripts/requirements.txt`.
- Run from the repository root. `node_modules/.bin/cf` is the project's installed
  CLI; this setup does not assume Wrangler. No Cloudflare account or paid cloud
  resources are needed for local D1/R2 simulation.

Example shell setup (use an installed Python 3.10+ interpreter):

```sh
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install -r scripts/requirements.txt

WORK="$(mktemp -d -t audiolab-local)"
export AUDIOLAB_LOCAL_STATE="$WORK/state"
export AUDIOLAB_BASE_URL="http://127.0.0.1:5173"
```

`WORK` exists; its child `state` must **not** exist yet. For a durable installation,
choose a new directory outside the repository instead of temporary storage.
Never publish, commit or upload that directory. Existing directories are refused,
including an empty pre-created state directory; this prevents accidental adoption.

## Initialize schema and first admin

First inspect the plan (no writes):

```sh
python scripts/init_local.py --state-root "$AUDIOLAB_LOCAL_STATE"
```

Then initialize the explicitly new local environment:

```sh
python scripts/init_local.py --state-root "$AUDIOLAB_LOCAL_STATE" \
  --initialize --server-stopped \
  --username local-admin \
  --project-name "Listening study" --project-slug listening-study
```

The initializer:

1. Requires a new root outside this repository; creates it mode 0700.
2. Reads the actual literal D1 `DB` binding ID from `cloudflare.config.ts`. It never
   substitutes a hardcoded project/user/database ID. A changed dynamic config
   shape fails explicitly rather than guessing.
3. Applies the existing migration files using the installed `cf` CLI with
   **`--local --persist-to EXACT_ROOT`**. No remote option is exposed. W01/0010 is
   still reserved on its branch; no substitute migration or workflow tables.
4. Creates a random stable account ID and project ID. Project, account and admin
   membership commit together using existing `projects`, `auth_accounts` and
   `project_members`; no duplicate identity model or public bootstrap API.
5. Writes the random password only to `admin-credentials.json` (0600). The database
   holds the existing salted PBKDF2 hash contract, not a plaintext password.
   Account/project IDs and non-secret status are in `environment.json`.

This is an offline first-admin operation for a new local store. It cannot adopt,
promote, reset or overwrite an existing account. `--server-stopped` is an operator
assertion: it is not a process detector. Production accounts/Access links require
[controlled Access provisioning](AUTHENTICATION.md#first-production-administrator).

If interrupted, retain the managed directory and its journal; do not reset it.
Stop any server using it, then resume the same initialization:

```sh
python scripts/init_local.py --state-root "$AUDIOLAB_LOCAL_STATE" \
  --initialize --resume --server-stopped
```

Resume accepts only this tool's matching private journal. It reapplies only pending
migrations and verifies any already committed bootstrap; no password rotation.
An already `ready` journal returns without provisioning or migrating again.
After research use, migrations/upgrades need a separate backup/review workflow;
this initializer is not an upgrade or account-recovery utility.

## Start the local Worker

Use the **same** persistence root in the server terminal:

```sh
AUDIOLAB_ENV=local AUDIOLAB_AUTH_MODE=demo pnpm exec vite dev --host 127.0.0.1 --port 5173 --strictPort
```

`AUDIOLAB_LOCAL_STATE` must remain exported. Vite and `cf --persist-to` both resolve
this root's `v3` state. D1 and the R2 binding are simulated locally. R2 objects are
created lazily when you upload; there is no cloud bucket-creation command.

Open the exact origin `http://127.0.0.1:5173/`. Sign in as the configured username
with the private generated password. Do not save/publish shared credentials. This
login works only in DEV on loopback; a production build cannot enable it.

The bootstrap project is ready for dataset imports and Task Definition authoring.
Additional projects can use the existing authenticated Project Configuration flow.
For labellers, stop the server and use [account provisioning walkthrough](WORKFLOW.md#project-and-independent-accounts),
then restart the same root. Creating a membership alone does not create an account.

## Import the example without hardcoded IDs

In another terminal, activate the same venv and export the same state/origin.
Read the newly generated **project ID**, not an example UUID:

```sh
PROJECT_ID="$(python -c 'import json,os; from pathlib import Path; print(json.loads((Path(os.environ["AUDIOLAB_LOCAL_STATE"])/"environment.json").read_text())["projectId"])')"

python scripts/import_dataset.py --adapter canonical --offline \
  --manifest examples/datasets/synthetic/manifest.json \
  --root examples/datasets/synthetic/audio --output "$WORK/offline-plan"

python scripts/import_dataset.py --base-url "$AUDIOLAB_BASE_URL" \
  --project-id "$PROJECT_ID" --create-dataset "Synthetic tones" --dataset-version v1 \
  --credentials-file "$AUDIOLAB_LOCAL_STATE/admin-credentials.json" \
  --adapter canonical --manifest examples/datasets/synthetic/manifest.json \
  --root examples/datasets/synthetic/audio --output "$WORK/import-plan" --import
```

The schema-v1 example UUIDs are deterministic **planned aliases**, not real
project/user IDs. Explicit named dataset creation materializes a real dataset ID
in generated batches; audio uploads replace planned audio aliases with actual
registered IDs. The committed example manifest is not modified.

For a guided path, use `--interactive --import --credentials-file ... --base-url ...`:
choose from your authenticated admin projects, select/create a dataset, then choose
Canonical JSON and the example paths. No default demo project or identity is used.

Stop the dev server with Ctrl+C. Keep the private state if you need to resume work;
temporary directories are not durable backups. Never use a DB reset to fix a 500.

## Restart the same local installation

Stop this installation's server with Ctrl+C. Keep its state directory and private
credential files. In a new terminal, return to the repository, activate the Python
venv when using the CLI, and explicitly select the SAME persistence root:

```sh
export AUDIOLAB_LOCAL_STATE="/absolute/path/to/your/existing-private-state"
export AUDIOLAB_BASE_URL="http://127.0.0.1:5173"
AUDIOLAB_ENV=local AUDIOLAB_AUTH_MODE=demo pnpm exec vite dev \
  --host 127.0.0.1 --port 5173 --strictPort
```

Do not rerun initialization, generate a new `WORK`, or copy state from another
installation to restart. A fresh state root will correctly show an empty/new
installation, not the datasets from your previous root. Local passwords are those
in that root's private credentials files; the release ships no shared password.

For local upgrades, stop the server, back up the entire private state plus
credentials, verify the intended D1 binding/persistence root and compare migration
history before applying reviewed pending migrations. Keep D1 metadata and R2 audio
together. Test recovery on a separate disposable environment; a Git checkout does
not roll back data. Production recovery is in [deployment](DEPLOYMENT.md).
