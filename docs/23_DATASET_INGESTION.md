# Canonical dataset ingestion — local and HTTPS Access interfaces

Use [fresh local setup](22_FRESH_LOCAL_SETUP.md) for an empty database/admin account.
The importer remains `scripts/import_dataset.py`; canonical **schema v1**, existing
D1/R2 tables, MMAU and paired WAV/TextGrid adapters are preserved. No dataset-import
UI or replacement domain model. [Testing](TESTING.md) distinguishes executed local
and isolated production checks from actual two-identity Cloudflare staging acceptance.

## Modes and authenticated local commands

Install Python dependencies from `scripts/requirements.txt` in a venv and install
Node dependencies using the existing pnpm lockfile. Node and the TypeScript/Zod
bridge are required even for offline validation; Python does not duplicate the
canonical schema validator.

- Default / `--dry-run`: plan/validate without dataset/audio/source writes.
- `--offline`: no HTTP or login; infer the dataset alias from a canonical manifest
  if `--dataset-id` is omitted. Write private plan/report files only.
- Online dry-run: authenticate, verify admin/dataset scope, inventory assets and
  call backend validation. Unregistered planned audio is explicitly pending upload,
  not a successful database import. Login/logout can write session/limiter records;
  “validation-only” does not mean zero filesystem/session writes.
- `--import`: explicitly upload/reuse audio and persist bounded metadata batches.
- `--inspect`: authenticated admin read of an exact source item, saved to private
  `inspection.json`; it can include private original/reference annotations.

Local authentication: controlled loopback **HTTP** origin only (`--auth local`, the default). Passwords come
from a hidden prompt or private `--credentials-file` (CLI JSON / one password line /
legacy `demo-login.txt`); never password arguments. Alternatively borrow a private
Netscape `--cookie-file`. Owned local sessions log out on exit; borrowed sessions
are not revoked. Redirects, proxy inheritance and raw claimed actor IDs cannot
grant access. A supplied `--user-id` must match verified login. The username prompt
has no hardcoded demo default. `AUDIOLAB_BASE_URL` is the supported origin override;
`DEMO_BASE_URL` remains a backward-compatible fallback.

Examples below assume `PROJECT_ID`, `AUDIOLAB_BASE_URL`, `AUDIOLAB_LOCAL_STATE` and
`WORK` from the setup guide. Explicit named dataset creation may remain empty if a
later step fails; it is not a whole-import transaction.

```sh
python scripts/import_dataset.py --base-url "$AUDIOLAB_BASE_URL" \
  --project-id "$PROJECT_ID" --create-dataset "My recordings" --dataset-version v1 \
  --adapter canonical --manifest /path/to/manifest.json --root /path/to/audio \
  --credentials-file "$AUDIOLAB_LOCAL_STATE/admin-credentials.json" \
  --output "$WORK/my-import" --import
```

For an existing dataset, use `--dataset-id DATASET_ID`. A canonical manifest must
match that ID unless you explicitly add `--retarget-dataset`. Retargeting changes
only the generated envelope, never the source file, sample/item/source-version
identities or recorded reference values. `--source-version` builds adapter output;
canonical imports use the manifest's own `source_version`.

Dry-run an existing target with the committed example template:

```sh
DATASET_ID="$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["datasetId"])' "$WORK/import-plan/report.json")"
python scripts/import_dataset.py --base-url "$AUDIOLAB_BASE_URL" \
  --project-id "$PROJECT_ID" --dataset-id "$DATASET_ID" --retarget-dataset \
  --adapter canonical --manifest examples/datasets/synthetic/manifest.json \
  --root examples/datasets/synthetic/audio \
  --credentials-file "$AUDIOLAB_LOCAL_STATE/admin-credentials.json" --dry-run
```

Inspect one exact imported item, using identities returned in `acceptedItems`:

```sh
RECORD_ID="$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["acceptedItems"][0]["source_record_id"])' "$WORK/import-plan/report.json")"
AUDIO_ID="$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["acceptedItems"][0]["audio_id"])' "$WORK/import-plan/report.json")"
python scripts/import_dataset.py --base-url "$AUDIOLAB_BASE_URL" \
  --project-id "$PROJECT_ID" --dataset-id "$DATASET_ID" \
  --record-id "$RECORD_ID" --audio-id "$AUDIO_ID" --inspect \
  --credentials-file "$AUDIOLAB_LOCAL_STATE/admin-credentials.json" \
  --output "$WORK/admin-inspection"
```

Backend paths remain `/api/v1/dataset-ingestion/{validate,import,inspect}` with
verified `projectId`/`userId` scope. Inspection includes protected labels **only**
after admin checks; worker projection is a separate allowlist.

## Complete custom example: same files, local or Cloudflare

**Terminal:** activate the installed Python venv. `WORK` must be a private durable
working directory outside Git; choose a new `DATA` directory. Copy only the
redistributable synthetic recording:

```sh
DATA="$WORK/custom-tones"
export DATA
mkdir -p "$DATA/audio"
cp examples/datasets/synthetic/audio/steady-tone.wav "$DATA/audio/tone.wav"
```

Save the following complete JSON as `$DATA/manifest.json` once. These UUIDs are
synthetic planned aliases; explicit named creation below retargets the dataset
and substitutes the actual uploaded asset ID. Keep sample/item/version IDs stable
on retries, and generate your own IDs for an unrelated corpus.

```json
{
  "schema_version": 1,
  "dataset_id": "f634c610-6ceb-5cc6-a2c5-e455260da614",
  "source_version": "v1",
  "provenance": {"origin": "custom-tones", "revision": "v1"},
  "records": [{
    "sample_id": "tone-001",
    "audio_id": "1b1e9f72-6fb8-5356-a9ad-eb4ca2a314f8",
    "metadata": {"originalPath": "tone.wav", "license": "CC0-1.0"},
    "fields": {"instruction": {"type": "text", "visibility": "worker", "value": "Listen independently."}},
    "items": [{
      "item_id": "q1",
      "fields": {
        "prompt": {"type": "text", "visibility": "worker", "value": "What kind of tone is audible?"},
        "category": {"type": "choices", "visibility": "worker", "value": [
          {"id": "steady", "label": "Steady tone"},
          {"id": "pulsed", "label": "Pulsed tone"}
        ]}
      },
      "reference": {"field": "category", "value": "steady"}
    }]
  }]
}
```

The directory is `custom-tones/manifest.json` plus `custom-tones/audio/tone.wav`.
The envelope, provenance, record IDs, item IDs and item fields are required.
Sample `fields`/`metadata` default to empty objects at the API, but the CLI needs
`metadata.originalPath` when uploading a local file. Item `annotations` defaults
to an empty array; `reference` is optional. For grounding, add an optional typed
`textgrid` field using the [complete bundled manifest](../examples/datasets/synthetic/manifest.json).
Do not invent nested reference objects: canonical v1 references support scalar
values or choice-ID arrays, not a universal temporal ground-truth schema.

Validate without authentication or remote writes:

```sh
python scripts/import_dataset.py --adapter canonical \
  --manifest "$DATA/manifest.json" --root "$DATA/audio" \
  --offline --dry-run --output "$WORK/custom-validation"
```

**Local terminal:** keep the local server running. Use the exact existing project
UUID and the initializer's private admin credentials:

```sh
python scripts/import_dataset.py --base-url "$AUDIOLAB_BASE_URL" \
  --project-id "$PROJECT_ID" --create-dataset "Custom tones" --dataset-version v1 \
  --adapter canonical --manifest "$DATA/manifest.json" --root "$DATA/audio" \
  --auth local --credentials-file "$AUDIOLAB_LOCAL_STATE/admin-credentials.json" \
  --output "$WORK/custom-local-import" --import
```

**Cloudflare terminal:** `APP_ORIGIN` is the exact canonical HTTPS origin, and
`PROJECT_ID` is a cloud project where the verified account is administrator. The
operator's cf management login is separate from this **human application token**:

```sh
cloudflared access login --quiet "$APP_ORIGIN"
python scripts/access_token.py --origin "$APP_ORIGIN" \
  --output "$WORK/admin-access-01.json"
python scripts/import_dataset.py --base-url "$APP_ORIGIN" \
  --project-id "$PROJECT_ID" --create-dataset "Custom tones" --dataset-version v1 \
  --adapter canonical --manifest "$DATA/manifest.json" --root "$DATA/audio" \
  --auth access --access-token-file "$WORK/admin-access-01.json" \
  --output "$WORK/custom-cloud-import" --import
```

Each person completes their own OTP; the file stores the token privately without
printing it. Use a new output filename when renewing. HTTPS/TLS checks stay on;
redirects and credentials sent to another origin are rejected. No password,
service token or Cloudflare infrastructure role substitutes for project admin.

Retry the **identical import command** against the same project/name/version,
manifest, audio paths and source version. It reuses the dataset/assets and checks
immutable content, rather than duplicating or replacing originals. Keep private
attempt reports; an interrupted request may already have committed. A conflicting
file/reference must use an explicitly new source version/dataset, not a forced
replacement. `--create-dataset` requires `--import`; use offline validation first
or an existing `--dataset-id` for an authenticated online dry-run.

**AudioLab UI:** select the project and open Task Builder. In the dataset/source
selectors choose Custom tones and its recording/item; preview `item.prompt` and
bind Choices source to `item.category`. Add blocks, save and publish, then use
Team & assignments to allocate work. Importing alone creates no annotation task.
The original `reference` is retained in protected `source_labels`, separately from
labeller submissions; default labeller visibility does not include it. Explicit
training disclosure requires a newly published training protocol. For exact
admin inspection, read `datasetId` and `acceptedItems` from the private report
and use the `--inspect` commands above with the same local or Access auth flags.

## Canonical schema v1 and binding identities

See [example manifest](../examples/datasets/synthetic/manifest.json) and authoritative
`lib/backend/validation/dataset-ingestion.ts:ingestionSchema`. One envelope contains:

| Field | Contract |
| --- | --- |
| `schema_version` | Literal integer 1 |
| `dataset_id` | Actual registered dataset UUID at the API; CLI aliases can be materialized explicitly |
| `source_version` | 1–60 letters/digits/underscore/dot/hyphen; changes create new source identity |
| `provenance.origin`, `.revision` | Same bounded identifier syntax; retained with originals |
| `records[].sample_id` | Stable external sample identity; unique across an import manifest |
| `records[].audio_id` | Registered audio UUID, or a planned alias with explicit local `metadata.originalPath` and `--root` |
| `records[].fields` | Typed sample-level source fields, maximum 100 |
| `records[].metadata` | Flexible JSON object; not worker-visible arbitrary metadata |
| `records[].items[].item_id` | Stable item/question ID within the sample; 1–20 items per sample |
| `items[].fields` | At least one typed field, maximum 100; use explicit names, not display labels |
| `items[].annotations` | Optional original early answers; preserve independently of worker submissions |
| `items[].reference` | Optional original reference answer; preserved as a protected source label |

Source fields declare `type`, `visibility` (`worker` or `admin`) and `value`.
Supported types: text (<=20,000 characters), finite number, Boolean, choices
(2–50 unique IDs with labels), interval TextGrid. Field names use a letter followed
by letters/digits/underscores, up to 64 characters. Choice/sample/item/provenance
identifiers are bounded; changing display text is not a replacement for stable IDs.

- Binding paths are `sample.FIELD` / `item.FIELD` (legacy MMAU question/choices remain).
  Source-bound Task Instances pin published definitions and worker-safe input
  snapshots. Importing a new source version does not reinterpret old revisions.
- `metadata.originalPath` is an explicit relative WAV path under `--root`, used for
  the CLI's upload adapter. No fuzzy filename search for canonical records.
- Dataset identity is project-scoped. Source identity uses dataset + sample + item
  + source_version, pinned to an asset. An identical retry is idempotent; conflicting
  content or audio identity fails. Use a new version/dataset deliberately.
- One alias may not name different WAV paths. Duplicate sample IDs across metadata
  batches are rejected during planning rather than discovered after partial import.
- Private metadata/reference answers stay out of ordinary worker context. A choice
  reference can be deliberately released only through explicit training configuration
  and newly pinned task inputs; see below. Mark a
  field `worker` only if revealing its full value to assigned labellers is intended.
  An `admin` TextGrid cannot be bound as a worker prefill by hiding it in the UI.

## Original answers: exact JSON pattern

The complete working custom-dataset example is
[`examples/datasets/synthetic/manifest.json`](../examples/datasets/synthetic/manifest.json).
Its audio directory contains `steady-tone.wav` and `pulsed-tone.wav`; no external
corpus is required. `metadata.originalPath` names each file relative to `--root`.
Validate offline, import, inspect and retry with the commands above, then use the
[full account/annotation walkthrough](WORKFLOW.md).

Inside each `records[].items[]`, declare the choices and original reference:

```json
{
  "item_id": "listen",
  "fields": {
    "category": {
      "type": "choices",
      "visibility": "worker",
      "value": [
        {"id": "steady", "label": "Steady tone"},
        {"id": "pulsed", "label": "Pulsed tone"}
      ]
    }
  },
  "reference": {"field": "category", "value": "steady"}
}
```

This is an item fragment, not the whole envelope. `reference.field` names an item
field (`category`, without the `item.` prefix); `reference.value` uses its stable
option ID, not display text or an array index. For multiple choice it can be an
array of distinct configured option IDs. Choice definitions require unique IDs; unknown reference IDs and wrong types
are rejected. Use each selected reference ID only once; analytics does not treat
repeated IDs as a valid set reference. `reference` is optional and stays separate from `fields` and from
labeller submissions. It is stored in `source_labels` with
`kind: "reference_answer"`; the saved payload retains `field` and `value`.

Other canonical reference values may be text, finite number or Boolean matching
the declared field type. Arbitrary nested reference objects are not canonical v1.
For temporal source annotations use a typed `textgrid` field, such as the bundled
admin-only `item.alignment`, rather than inventing an interval-array reference
schema. A protected TextGrid is not automatically labeller prefill or an accuracy
track. The current original-answer evaluation supports uniquely mapped choice
answers; support for importing a value does not imply an evaluation metric exists.

The MMAU adapter converts its original `answer` text into a canonical choice ID
and this same reference shape. Legacy already-stored MMAU labels can contain
`{"value":"ANSWER_TEXT"}`; their compatibility reader remains supported. Keep
benchmark content private unless its rights separately permit redistribution.
All public tutorials use the CC0 tones instead.

### Binding and optional training disclosure

Bind Question/title to `item.prompt` and Choices source to `item.category` for
this synthetic example. Legacy MMAU uses `question`/`choices`; canonical MMAU
adapter output uses `item.prompt`/`item.options`.

References remain private by default. For an intentional training form, enable
**Training task: allow original answer preview for labellers**, select
`reference_answer` as Existing answer preview, and keep Show existing answer
in Preview and Workspace enabled. Builder resolves the selected administrator
sample, including every recording in a batch, and displays readable option labels.
Save and publish a new version, then allocate NEW assignments. The server pins only
the selected original choice value(s), without sibling metadata/other labels.
Existing published instances and submitted answers are unchanged. Turning training
off later cannot retract an answer already shown in an older training task.
Training is not blind evaluation. [Workflow](WORKFLOW.md#original-answer-previews-for-explicit-training).

If preview reports unavailable/protected, verify the selected source has a
reference, Training and Show are enabled, and the choices binding points to that
reference's field. Use the authenticated administrator sample and inspect the
item through `--inspect`; do not change source visibility to suppress an error.
Malformed, absent or ambiguous original labels are unavailable rather than guessed.

## Audio and source-artifact limits

- Current CLI support is **uncompressed PCM WAV** supported by Python `wave`:
  finite positive frame count/rate, `.wav`, nonempty, **at most 10 MiB** per file.
  PCM16 mono/stereo is the conservative interchange choice; bundled fixtures are
  mono PCM16/8 kHz. PCM duration is computed from frames/rate and truncation is
  checked by reading the declared frames. No automatic decoding/transcoding.
- Compressed WAV, MP3, FLAC and IEEE-float WAV are not supported by this CLI
  release path. Python-version-specific extensible PCM support should be verified
  before use. The backend recognizes PCM/float/extensible RIFF tags, which is
  broader header recognition and is **not** a promise of CLI/browser compatibility.
- Backend asset metadata (duration/rate/channels/hash) is authoritative for stored
  audio. Arbitrary dataset metadata is retained, not used to override asset timing.
- Paired text TextGrid artifacts must be 1–100,000 bytes; UTF-8 / UTF-16LE/BE
  originals are preserved with encoding and SHA-256 where the adapter attaches a
  file artifact. IntervalTier supported; arbitrary Praat formats are not implied.
- API metadata request maximum 256 KiB. CLI batches target <=250 KiB UTF-8, <=20
  samples and <=50 total items; the schema separately limits each sample to 20
  items. Oversized single samples must be explicitly reorganized, not truncated.

Paths resolve under the selected root. Absolute/escaping canonical paths and
symlink escapes fail. Paired WAV/TextGrid matching is exact same-directory/stem;
ambiguous pairs fail. Missing pairs are reported/skipped unless `--require-textgrid`.
MMAU keeps its explicit original safe path/choice adapters and still emits canonical
v1; it does not download datasets or execute strings as code.

## MMAU and paired-folder compatibility

```sh
python scripts/import_dataset.py --base-url "$AUDIOLAB_BASE_URL" \
  --project-id "$PROJECT_ID" --create-dataset "Paired intervals" --adapter paired-textgrid \
  --root /path/to/wav-and-textgrid --require-textgrid --annotation-visibility admin \
  --credentials-file "$AUDIOLAB_LOCAL_STATE/admin-credentials.json" --import

python scripts/import_dataset.py --base-url "$AUDIOLAB_BASE_URL" \
  --project-id "$PROJECT_ID" --create-dataset "MMAU study" --adapter mmau \
  --manifest /path/to/mmau.json --root /path/to/mmau-audio \
  --credentials-file "$AUDIOLAB_LOCAL_STATE/admin-credentials.json" --import
```

MMAU choices may use declared list/lines/delimiter formats. The legacy
`import_mmau.py` helpers are reused; its old unauthenticated standalone pilot is
not the supported release command. `import_dataset.py --adapter mmau` is the
verified authenticated entrypoint.

## Partial failures and safe retries

`report.json` and `attempts/ATTEMPT_ID.json` are private (0600). Plans can contain
original/reference data; keep the entire output outside public repos/shares.
Each attempt reports phase/status, target dataset name/version/known ID, pending
upload/batch, acknowledged uploaded/reused asset IDs, accepted source identities
and `completedBatches`. Separate attempt files survive retries in the same output.

There are three durability boundaries:

1. Dataset registration is independent and can leave an empty named dataset.
2. Each WAV uses R2 upload then D1 registration with existing best-effort R2 cleanup
   on SQL failure. Earlier uploads remain if later work fails.
3. Each metadata batch is atomic in D1; the whole corpus is **not** one transaction.

A dropped response after a commit means the journal cannot acknowledge that write.
`remoteStateMayHaveChanged:true` and the pending phase mean **unknown until checked**,
not “rolled back.” `completedBatches` means acknowledged batches only. No automatic
reset, destructive cleanup, blind metadata replacement or password reset occurs.

Retry the **same original command and input bytes**. Named registration reuses
name+version; asset paths reuse registered IDs after SHA-256 verification (legacy
missing digests use a bounded authorized byte read). A concurrent upload's 409 also
requires exact bytes before reuse. Canonical hashes make identical metadata replay
idempotent, including batches committed before a lost response. Different bytes or
source contents fail explicitly; never relink prior annotations to changed audio.
Session expiry/401/403 must be resolved through authentication/permissions, not
retries with a forged actor ID. The local login limiter remains enabled; automation
can borrow one private session jar rather than repeatedly signing in.

## Production HTTPS Access commands

The HTTPS interface implements explicit `--auth access` with `--access-token-file`. Use a human
Access **application** JWT for the canonical HTTPS hostname, explicitly linked to
an active AudioLab account with project admin membership. Passing Access alone is
insufficient. This path is verified with isolated signed test identities and real
local Worker/D1/R2 over TLS. Actual workers.dev staging also passed real email
OTP/account linking, HTTPS canonical import, exact retry without duplicate assets
and authorized inspection using the bundled synthetic CC0 inputs. This verifies
the human-token CLI path, not machine/service identities or arbitrary corpora.
See [authentication](AUTHENTICATION.md) and [deployment](DEPLOYMENT.md).

Cloudflare supports [human application token acquisition](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)
and [service identities](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
Service tokens identify a machine with `common_name` and an empty user `sub`;
AudioLab v1 intentionally rejects them rather than silently granting admin rights.
Automated imports must use an approved human session in this release; unattended
machine provisioning requires separately reviewed scope.

Install the official `cloudflared` client separately. After configuring Access and
provisioning your account, acquire a credential **without printing it**:

```sh
export AUDIOLAB_BASE_URL="https://YOUR_CANONICAL_HOST"
cloudflared access login "$AUDIOLAB_BASE_URL"
python scripts/access_token.py --origin "$AUDIOLAB_BASE_URL" \
  --output /private/path/audiolab-access.json
```

The wrapper captures `cloudflared access token --app=ORIGIN` into a new mode-0600
file with `{ "origin": "https://YOUR_CANONICAL_HOST", "token": "APPLICATION_JWT" }`.
Existing files are refused; renew to a new path and explicitly switch the importer.
Never copy the token to command arguments, paste it into source or commit the
credential. The credential must match the exact configured origin, independently
of the CLI target. No proxies or redirects can forward it to another hostname.
TLS certificate/hostname verification remains enabled. Local passwords/cookie
jars cannot be combined with Access mode and there is no automatic fallback.

Use the actual project UUID from your authenticated session/project configuration:

```sh
python scripts/import_dataset.py --auth access \
  --base-url "$AUDIOLAB_BASE_URL" \
  --access-token-file /private/path/audiolab-access.json \
  --project-id "$PROJECT_ID" --create-dataset "Synthetic tones" --dataset-version v1 \
  --adapter canonical --manifest examples/datasets/synthetic/manifest.json \
  --root examples/datasets/synthetic/audio --output /private/path/import-report --import
```

For validation of an existing dataset, replace `--create-dataset ...` with
`--dataset-id "$DATASET_ID" --retarget-dataset` and `--import` with `--dry-run`.
Inspection uses the same `--auth access --access-token-file ...` pair and the exact
`--project-id`, `--dataset-id`, `--record-id`, `--audio-id`, `--inspect` flags shown
above. MMAU and paired adapters use the same authentication flags; canonical v1,
source visibility, WAV/payload bounds and private per-attempt journals are unchanged.

401/403, an HTML Access challenge or a redirect is an authentication/permission
failure, not a successful import. Renew expired credentials for this application
and verify issuer/subject/account/project permissions; no TLS/DEV bypass or forged
actor ID is a remedy. Exact retries after reauthentication retain existing data.
Borrowed Access tokens are not revoked when the importer exits. Use AudioLab/Access
logout or operator account deactivation when revocation is intended.
