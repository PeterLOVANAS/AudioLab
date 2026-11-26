# Synthetic classification and grounding dataset

Two generated 4-second mono PCM16/8 kHz WAVs (64,044 bytes each), with canonical
schema-v1 metadata and protected reference annotations. No external recordings,
voices, downloaded corpora or samples. Data/manifest/annotations in this directory
are dedicated under [CC0](LICENSE); the project-wide source license is separate.

- `steady-tone.wav`: 440 Hz, audible from 1–3 s.
- `pulsed-tone.wav`: 660 Hz, audible from 0.5–1.5 and 2.5–3.5 s.
- `item.prompt`, `item.category` and `sample.instruction` are worker-visible fields.
- Classification reference labels, `item.alignment` TextGrid and frequency metadata
  are admin-only. Grounding labellers should annotate independently by default.
  An intentional editable prefill requires an explicit visibility decision/new
  source version; a reference is never exposed automatically.

`dataset_id` / `audio_id` values are deterministic planned aliases, not existing
application identities. Explicit named import/retarget binds a real dataset and
uploads/reuses actual audio IDs without editing this manifest.

See [fresh setup](../../../docs/22_FRESH_LOCAL_SETUP.md) and
[ingestion commands/contracts](../../../docs/23_DATASET_INGESTION.md).

Regenerate into a new directory, never over existing data:

```sh
python scripts/generate_example_dataset.py --output /path/to/new-synthetic-example
```

The generator uses only Python standard library sine synthesis. `SHA256SUMS.json`
records supplied audio hashes; the reproducibility test compares exact generated
bytes and validates the manifest against the actual backend schema.
