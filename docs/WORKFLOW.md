# Synthetic-data annotation walkthrough

Follow [installation](22_FRESH_LOCAL_SETUP.md) and import the bundled four-second
[CC0 dataset](../examples/datasets/synthetic/README.md). Keep state, credentials,
reports and backups outside the repository. This walkthrough needs no research
corpus or hardcoded project/account IDs.

## Project and independent accounts

The initializer creates a project and admin membership. Select it in the sidebar;
Project configuration can create another project or an editable starter definition.
It does not modify a published version or register production identities.

For local independent labellers, stop the server using this explicit state root:

```sh
python scripts/import_labellers.py --state-root "$AUDIOLAB_LOCAL_STATE" \
  --manifest docs/examples/labellers.json --project-id "$PROJECT_ID"
# Review the plan, then explicitly apply it with the server stopped:
python scripts/import_labellers.py --state-root "$AUDIOLAB_LOCAL_STATE" \
  --manifest docs/examples/labellers.json --project-id "$PROJECT_ID" \
  --credentials-out "$WORK/labellers-private.json" --import --server-stopped
```

These fictional example profiles are reusable templates. The tool creates account,
membership and worker profile using existing models, backs up before writes, and
refuses privilege takeover. Passwords are generated privately. Restart with the
same root; each labeller signs in separately. Production uses
[controlled Access linking](AUTHENTICATION.md), not this local password utility.

## Build, bind and publish

1. Open Task Builder and choose **Save to project**; it has its own selector.
2. Name the study, enter independent listening instructions and choose the
   imported dataset/recording/source record for preview.
3. Add Single choice. In its dataset settings bind **Question / title** to
   `item.prompt` and **Choices source** to `item.category`. IDs `steady`/`pulsed`
   persist while readable labels are displayed. Bind instructions to
   `sample.instruction` if desired.
4. Add Boolean, numeric/rating, text or other supported blocks as needed. For a
   separate grounding form add the sound-grounding block with an interval Events
   tier and optional overlap. Keep the example's `item.alignment` admin-only;
   references must not be offered as worker prefill.
5. Set independent votes to two for this two-person example, keep independent
   answers blind, check Labeller Preview, save and publish.
6. Record the published version. Editing now changes a draft; existing Task
   Instances keep their frozen version. Publish a new version for future jobs.

Supported authoring: single/multiple choice, Boolean, number, rating, text,
transcript, ranking, audio comparison, timeline, manual repeated group and
section/callout/audio display. Legacy candidate ballots remain readable; new
ballot authoring and deferred continuous/summary controls are not promised.
For multiple recordings configure the block's batch/slot settings and select
matching ordered inputs; do not pretend one recording is several independent clips.

## Team and allocation

In Team & assignments select active, account-ready Alice/Bob, optionally save a
reusable team, choose the published protocol and Synthetic tones dataset. Choose
Voting so both workers receive the same recording; sample one item with a recorded
seed. Preview, check source/worker counts and then **Confirm & save assignments**.
One unique recording now has two assignments. Individual mode partitions items;
Voting collects independent responses, not an accepted majority answer.

Team edits affect future jobs, not frozen allocations. Allocation failures are
not successful launches. Reusing an identical launch is idempotent. Do not create
new identities by changing a client labeller ID.

## Labeller workspace and revisions

Sign in as each labeller in a separate session. Open Workspace, select Assigned
job and a queue row. Only owned assignments/authorized audio are accessible.
Listen to the actual WAV, answer, wait for **All changes saved**, reload and reopen
the same row. Autosave appends a draft revision; it is not final submission.

For the steady-tone grounding task mark `[1,3]` seconds, label `tone`, and save the
segment. For pulsed audio mark `[0.5,1.5]` and `[2.5,3.5]`. Drag outside existing
segments to create a new selection; dragging a segment edits it. Use precision
inputs/timed table, then wait for account autosave. Public prefill is opt-in and
cannot reveal an admin-only reference by hiding it in the UI.

Submit independently. Final answers become read-only, earlier drafts remain and
repeat submission is rejected. A stale revision receives 409; reload/reconcile
instead of overwriting. If authentication expires, reauthenticate and reload the
persisted draft; in-memory unsaved edits are not a durable recovery queue.

## Progress and export

Return as administrator. Progress Overview reports item/assignment/submission
counts; Labeller Analysis shows per-person progress. Final Results stays gated
until both assignments are submitted. Inspect block distributions or temporal
tracks/matrix. [Metric definitions](RESULTS.md) explain denominators, absence and
unavailable scores.

Research exports provides job JSON, per-audio JSON ZIP and JSON + WAV ZIP. Finals
and revision provenance remain independent. Partial downloads contain available
finals only and are labelled incomplete. Private references and drafts are absent;
ranking/comparison remains task scoped. Store exported research data privately.

## Exact ten-second grounding acceptance

The 1/3 three-worker example needs ten-second audio; do not use out-of-bounds
intervals on the four-second quick-start clips. `pnpm run test:acceptance` generates
the ten-second fixture, imports it, publishes/allocates to three accounts, verifies
all block families and drives actual browser interval editing before restart and
export checks. [Testing](TESTING.md) · [demonstration checklist](DEMONSTRATION.md).

## Optional grounding aids and choice presentation

**Answer required** is at the top of each answer block's settings. An optional
batched block may be left entirely unanswered or used for only some recordings.
Any supplied answer must still be valid. A required grounding block needs at
least one valid segment for every configured recording; an optional aid never
requires invented empty responses to submit other questions.

Choose **Aid mode — labeller chooses words, phones or sounds** in grounding's
Research mode. It declares independent Words, Phones and Sound events tiers.
In Workspace each recording has an **Aid segment type** selector. Switching
between tiers preserves saved intervals. The separate required setting controls
whether this is only a listening aid or a required annotation. Published tier
identities remain fixed; labellers cannot invent unvalidated tier IDs.

Multiple choice offers **Checkboxes — two columns** under Answer appearance.
It uses native multi-select checkboxes with the same canonical option IDs and
selection limits. On narrow screens the grid becomes one column.

## Original-answer previews for explicit training

For MMAU-style records, bind Question/title to `question` and Choices source to
`choices` (or the corresponding canonical `item.*` fields). Normally original
answers remain private. To deliberately reveal the original answer:

1. In a choice block enable **Training task: allow original answer preview for
   labellers**.
2. Select `reference_answer` in **Existing answer preview**. This also enables
   **Show existing answer in Preview and Workspace**.
3. Check the selected source's preview, save, publish a new version and create
   new assignments from that version.

Only the chosen text answer or text-choice array is copied into the new pinned
training inputs. Sibling metadata, other reference labels and early annotations
are not released. Existing instances and published snapshots never change.
Turning training off requires another version and new assignments; it cannot
retract an answer already deliberately shown in an old training task. Training
responses are not blind research observations. Submitted values remain separate
from the read-only preview and never overwrite the original source answer.
