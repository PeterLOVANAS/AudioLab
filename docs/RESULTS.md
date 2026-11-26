# Final Results, metrics and export

Labeller progress has Progress Overview, Labeller Analysis and Final Results.
Backend services read frozen Task Instances, published versions, resolved runtime
blocks and immutable submitted revisions. The frontend does not recalculate IoU.
Sources: `lib/contracts/job-results.ts`, `lib/backend/services/job-results.ts`,
`result-analytics.ts`, `agreement.ts` and `components/admin/FinalResults.tsx`.

## Counts and completion

| Count | Denominator |
| --- | --- |
| Unique audio | Distinct asset IDs; multiple questions can share a recording |
| Source items | Selected sample/item/source-version identities |
| Expected assignments | Worker × Task Instance allocations; a task can contain multiple recordings |
| Submitted annotations | Persisted final-submitted assignments under completion policy |
| Valid observations | Shape-valid submitted values per block/audio/path, including explicit empty timelines |
| Excluded observations | Missing, invalid or unsubmitted values in that scope |
| Eligible pairs | Unordered independent pairs with a defined score |
| Excluded pairs | Considered pairs with unavailable scores, including empty–empty temporal pairs |
| Absence agreements | Explicit empty–empty pairs; separate from localization |

Final Results unlock only when a launched job has all expected assignments
submitted. Before that, results return `complete:false`, `remaining`, counts and
empty final block/item arrays. Progress remains visible. Partial Research Export
contains available finals only and is explicitly labelled; it is not a final
complete research result.

## Implemented block metrics

| Block | Rendering/metric |
| --- | --- |
| Single choice / Boolean | Stable-ID/Boolean frequencies and exact pair agreement |
| Multiple choice | Option-selection frequencies and set Jaccard: intersection / union cardinality |
| Number / rating | Count/mean/min/max; normalized agreement unavailable |
| Text / transcript | Readable originals and normalized character edit similarity; not WER/CER or accuracy |
| Ranking | Readable label/audio order and fraction of concordant unordered pairs for matching distinct-ID permutations; not labelled Kendall tau |
| Audio comparison | Exact choice agreement per ordered comparison group |
| Timeline | Label/tier-aware interval-set temporal IoU and original submitted tracks |
| Repeated group | Child/worker-local entry identities retained; no positional cross-worker alignment |
| Legacy candidate answer | Existing shapes/provenance readable; new ballot authoring not supported |
| Section / callout / audio player | Display only; not answer observations |

Text comparison normalizes NFKC, whitespace and case, then computes
`1 − edit_distance / max(normalized_lengths, 1)` within existing work bounds.
Undefined/unsupported metrics remain unavailable with a reason. These are
descriptive inter-annotator comparisons, not linguistic or scientific certification.

## Interval-set temporal IoU

For one pinned task/version, resolved block/path and audio slot, validate finite
seconds with `0 <= start < end` and known audio-end bounds. Preserve raw answers.
For metric computation only, sort copies and merge overlapping/touching regions
within each worker's exact `(tier ID, event text)` identity. Do not clip, swap or
coerce corrupt persisted values, or match random segment IDs.

For each identity compute occupied duration and intersection of the two merged
sets. Sum intersection and union durations across labelled identity spaces.
IoU = total intersection duration / total union duration. Different recordings,
event labels and unrelated repeated entries never intersect. Disjoint regions
are handled as a set, not a single bounding interval.

- Empty–nonempty: eligible score 0.
- Explicit empty–empty: absence agreement, excluded from temporal IoU by default.
- Missing, invalid, draft and unsubmitted are not explicit absence.
- No eligible pairs: null/unavailable, never NaN/Infinity or a fabricated zero.

Compute every eligible unordered labeller pair. Per-item mean/min/max include
valid pair counts and excluded counts. A job block mean weights **eligible pairs
equally** across pinned scopes, not items or durations. Numeric summaries pool
valid observations; the temporal histogram bins pair scores, not workers.

### Verified example

On a **ten-second synthetic recording**, all events labelled `tone`:

| Labeller | Intervals |
| --- | --- |
| A | [1,5] |
| B | [3,7] |
| C | [1,3], [5,7] |

Each pair has intersection 2 / union 6 = **1/3**. Mean/min/max = 1/3, valid pairs
= 3, excluded = 0. The interface displays 33.3%, six symmetric off-diagonal cells
and common-scale tracks. One recording, three assignments, three finals and three
valid grounding observations are different counts. Persisted API, Chrome editing,
playback and export consistency were verified. [Screenshot](images/grounding-results.png).
This fixture is distinct from the four-second quick-start dataset.

## Export consistency

`audiolab.research-export/1` preserves raw final answers, immutable revision IDs,
readable projections, pinned context and `audiolab.analytics/2` from the same
backend implementation. Separate downloads can have different `generatedAt`
timestamps; annotations/identities/metrics must match. Original private source
references stay excluded. `fieldsOrigin` distinguishes pinned inputs from
explicitly current-source legacy context or no source.

ZIP layout: `job.json`, `annotations/AUDIO_UUID.json`, and audio ZIP only
`audio/AUDIO_UUID.wav`. Multi-audio ranking/comparison stays whole-task scoped.
Exported raw intervals/counts permit independent reproduction; no majority,
reference accuracy or adjudication overwrites individual submissions.

## Question distributions, rankings and original answers

Final Results defaults to **Per-question votes**. Each card uses the resolved
published block, Task Instance and audio slot. A four-recording batch produces
four question scopes, each with its own option labels, counts and observation
and comparison denominators. Identical ordinal IDs such as `source-choice-1`
in unrelated questions do not establish a shared answer meaning.

**Pooled class frequencies** is a separate view for classification summaries.
It pools matching ID/label pairs within a block; it is not per-question voting.
For multiple choice, one valid response can increment several option counts,
so option totals may exceed the number of respondents.

Ranking cards show one histogram per configured recording or label. Each bar
counts how many valid complete rankings placed that canonical ID at a one-based
position. For example, two `[A,B]` rankings and one `[B,A]` yield A counts `[2,1]`
and B counts `[1,2]`. Individual and voting jobs use the same descriptive counts.
Audio comparisons retain separate comparison-group scopes and choice counts.
Repeated child responses are inspectable in their worker-local entry scopes;
independent entry UUIDs or row positions do not establish event correspondence.
No cross-worker repeated-entry ranking alignment is inferred.

**Original-answer matching** is a separate administrator-only exact-choice
comparison, not inter-annotator agreement or majority-derived accuracy. It uses
one unambiguous original imported `reference_answer` for the exact source record
and maps its string value(s) to the resolved question's unique option IDs/labels.
Static unbound forms, unknown/ambiguous references and missing/invalid responses
are unavailable, not mismatches. A worker bar shows matched / comparable
question responses and reports excluded responses separately. Batch panels each
contribute one question response. The reference is explicitly labelled
**current-source**, not pinned historical ground truth; reimporting references
can change this evaluation while immutable worker answers remain unchanged.
Training tasks are labelled as non-blind and must not be used as independent
accuracy evidence.

The additive `distributionVersion: "audiolab.distributions/1"` extends
`audiolab.analytics/2`. Each item includes `distribution.counts`,
`distribution.ranks` (position counts), and applicable `reference` availability,
reason and per-worker nullable match outcomes. Research Export uses the same
backend analytics. Raw private reference payloads and unrelated private metadata
remain excluded from exports; reference-match outcomes intentionally provide
administrator-only derived evaluation information. Explicit training tasks can
contain their deliberately released answer previews in the resolved task.
