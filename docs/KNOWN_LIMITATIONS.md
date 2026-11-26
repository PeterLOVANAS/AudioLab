# Known limitations

- Real workers.dev staging passed two-identity OTP/account linking, private D1/R2,
  HTTPS ingestion, Chrome annotation/playback, results and export. Three-labeller
  live acceptance, custom-domain integration, key rotation and extended recovery
  remain unverified; local production-mode tests do not replace those checks.
- No public signup, production password provider or service-token/machine account.
- CLI input is uncompressed PCM WAV up to 10 MiB; no implicit transcoding.
  [Audio/metadata limits](23_DATASET_INGESTION.md#audio-and-source-artifact-limits).
- Imports are atomic per metadata batch, not corpus-wide. Dataset/assets can
  remain after interruption; recover using identical input and private reports.
- Final Results are completion-gated. Partial exports contain available finals,
  never drafts. Export is job-based, not a standalone-assignment archive.
- Original references stay private except explicit choice-training disclosure into
  new pinned inputs. Exact-choice matching reads current imported originals, not
  pinned historical reference versions. Unsupported/ambiguous mappings are unavailable.
  No temporal reference track or adjudicated winner is inferred from agreement.
- Manual repeated rows lack cross-worker alignment; those metrics stay unavailable.
  Numeric/rating summaries are descriptive, not arbitrary normalized agreement.
- No workflow engine, adjudication UI, import UI, automatic ASR, kappa or WER/CER
  is promised by this release.
- Manual job selection: 1–50 items; entire dataset: at most 1000; at most 20
  workers and 24 recordings/task. Use reviewed batches for larger studies.
- Export JSON limit 32 MiB; archive preflight 256 MiB. Missing audio fails
  explicitly while retained raw final JSON remains available.
- Chrome playback state/seeking/geometry are verified. Audible sound, other
  browsers/mobile/accessibility and load behavior need manual acceptance.
  Acoustic/F0/formant/MFCC estimates are aids, not calibrated/Praat-equivalent data.
- Some legacy copy retains prototype terminology. Builder has its own project
  selector; choose it explicitly.
- Source-only publication excludes private development history and research data.
  Third-party bundle/native redistribution needs review of the actual artifacts;
  see the notices. Private staging acceptance does not authorize public dataset
  distribution.
