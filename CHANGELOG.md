# Changelog

## 1.0.0 — 2026-11-26

First source release. Package metadata is `1.0.0`; the package stays private and
is not intended for npm publication. Original AudioLab source uses Apache 2.0.

### Research annotation

- Versioned Task Builder, immutable published versions, source-field binding and
  pinned multi-recording Task Instances.
- Boolean/single/multiple choice, text/transcript, numeric/rating, temporal grounding,
  ranking/audio comparison and manual repeated groups.
- Two-column checkbox appearance, prominent required controls and per-recording
  optional word/phone/sound aids. Optional batched aids no longer block submission
  in either client or server validation; supplied answers remain validated.
- Explicit choice-training reference previews work in block settings, full Builder
  preview and new assigned tasks; canonical option IDs display readable labels.
- Independent team-job assignments, autosave/draft/resume, immutable final revisions
  and green successful-submission feedback.

### Results and operations

- Completion-gated progress/results, per-question voting, separate pooled class
  frequencies, rank-position histograms, current-source original-choice matching
  and interval-set pairwise temporal IoU with explicit denominators.
- Raw/readable JSON and per-audio JSON/audio ZIP export using authoritative analytics.
- Canonical v1 ingestion, MMAU and WAV/TextGrid adapters, PCM WAV/size validation,
  private import inspection/reports and safe identical retries.
- Reproducible fresh local D1/R2 initialization and controlled account provisioning.
- Cloudflare Access identity verification, project/assignment authorization,
  HTTPS human-token CLI ingestion and guarded Vinext/cf deployment configuration.
- Researcher/admin/API documentation, synthetic CC0 examples/screenshots, CI,
  disposable persisted/browser and built-Worker HTTP/TLS acceptance tooling.

### Release status

Local and isolated production-mode acceptance are recorded separately from live
Cloudflare staging. Real workers.dev OTP, private D1/R2, HTTPS ingestion and
Chrome annotation/results/export passed with one administrator and one labeller.
Three-labeller live and sustained-load acceptance remain unverified. Exact-revision
hosted CI, final human review, source/contributor/copied-code permissions,
third-party obligations and public
repository/history clearance remain release gates. Apache 2.0 is proposed only;
no project-wide source license has been applied. See [release notes](RELEASE_NOTES.md),
[limitations](docs/KNOWN_LIMITATIONS.md) and [checklist](docs/RELEASING.md).
