# AudioLab v1.0.0

AudioLab’s first source release provides a versioned, research-oriented annotation
workflow. See the [release and packaging guide](docs/RELEASING.md).
Actual workers.dev staging passed real email OTP for one administrator and one
labeller, private D1/R2, HTTPS import/retry, Chrome annotation/playback, results
and JSON/ZIP export. This is not three-labeller live or sustained-load acceptance. Original AudioLab
source is licensed under Apache 2.0; upstream terms are preserved separately.

AudioLab supports reproducible audio annotation for audio and multimodal AI
research: import recordings, publish a versioned form, allocate independent
labellers, preserve drafts/finals and retrieve research results with provenance.

## Highlights

- React/TypeScript and Vinext/Vite on Cloudflare Workers, D1 and private R2.
- Project memberships, Task Definitions/published versions, pinned Task Instances,
  teams, frozen job allocations and append-only Annotation Revisions.
- Boolean, single choice, multiple choice, numeric/rating, text/transcript,
  word/phone/sound grounding, ranking/audio comparison and manual repeated groups.
- Source-bound questions/options, batch recordings, two-column checkboxes and
  optional listening aids. Explicit training can reveal selected original choices;
  ordinary independent tasks keep private references hidden.
- Workspace playback, synchronized timelines and acoustic analysis aids,
  autosave/resume, validated submission and read-only finals.
- Progress Overview, Labeller Analysis and Final Results with per-question votes,
  pooled classification frequencies, ranking-position counts, original-choice
  matching and labelled interval-set temporal IoU. Agreement is not accuracy.
- JSON, per-audio JSON ZIP and JSON-plus-audio ZIP exports, with raw/readable
  answers, revision identities and the same authoritative analytics.
- Canonical dataset schema v1, stable identities, MMAU/WAV–TextGrid adapters,
  authenticated CLI validation/import/inspection and safe identical retries.
- Fresh local setup, controlled administrator/labeller provisioning, Cloudflare
  Access identity links, project/assignment checks and HTTPS CLI human tokens.

## Install and learn

Start with the [README](README.md), [fresh local setup](docs/22_FRESH_LOCAL_SETUP.md)
and [synthetic CC0 dataset walkthrough](docs/WORKFLOW.md). No benchmark or private
research data is needed. Use the pinned pnpm lockfile and Python requirements.
There is no shared default password; first-admin credentials are generated privately.

[Dataset JSON and CLI](docs/23_DATASET_INGESTION.md) ·
[API reference](docs/API.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Results/metrics](docs/RESULTS.md) · [Deployment](docs/DEPLOYMENT.md) ·
[Authentication](docs/AUTHENTICATION.md) · [Tests](docs/TESTING.md).

## Verification and limits

The repository provides offline regressions, Python units, migration/configuration
checks, a built-Worker HTTP/TLS security suite and disposable persisted Chromium
acceptance. The tagged source is verified separately by hosted checks and browser acceptance.
Local test tokens do not replace real Access/IdP evidence.

PCM WAV ingestion is limited to 10 MiB/file; no implicit transcoding or dataset-import
UI. No workflow engine, adjudication, automatic ASR, kappa or WER/CER is promised.
Manual repeated rows have no cross-worker alignment contract. Reference matching
uses current imported choices, not pinned historical ground truth. Acoustic
estimates are aids. Three-labeller live testing, human audible output, broader browser/
mobile/accessibility/load verification remain outside the verified scope.
See [known limitations](docs/KNOWN_LIMITATIONS.md).

## Thanks and provenance

AudioLab retains its Task Builder, Labeller Workspace, Team & Assignments,
Project Configuration/progress, prototype workbench and release-engineering
contributions. The maintainer confirmed contributor/source authority for Apache
2.0; role-based credits are retained pending preferred public names. [Acknowledgements](ACKNOWLEDGEMENTS.md),
[third-party notices](THIRD_PARTY_NOTICES.md) and [license status](docs/LICENSE_STATUS.md)
describe the release’s source and asset scope.
