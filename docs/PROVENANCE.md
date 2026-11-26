# Source and asset provenance decisions

The original development repository preserves contributor history privately. The
public repository contains the reviewed source selection and acknowledgements,
without importing private refs. The maintainer confirmed ownership/permission to
release original AudioLab contributions under Apache 2.0. No personal contact list
or unapproved affiliation is included.

| Component | Evidence | Distribution decision |
| --- | --- | --- |
| Prototype audio workbench | `PrototypeAudioPlayer.tsx` and CSS describe the original port | Maintainer states ownership and authorizes Apache 2.0; original source comments retained |
| Acoustic worker/analysis | Current files are byte-identical to audited historical prototype blobs `452dce609b58…` / `c6503f7b3e7c…` | Maintainer states ownership and authorizes Apache 2.0; historical absence of a license was not treated as a grant |
| Project Configuration/Progress teammate | Existing integration commit `53f5f09` retains contribution; active progress is TeamJobProgress | Maintainer confirms contributor authority for Apache 2.0; role-based credit retained |
| Historical migration compatibility fixture | Exact commit/hash in its [README](../fixtures/migration-compatibility/README.md); original migration untouched | Maintainer confirms authority for Apache 2.0; test-only, not a runtime engine |
| Current example dataset | Mathematical sine synthesis, exact generator/hash tests and scoped CC0 dedication | Scoped CC0 dedication and generator provenance retained |
| Curated UI screenshots | Verified synthetic-data Chrome acceptance, no private corpus | Maintainer confirms underlying contribution rights; no blanket screenshot CC0 claim |
| Dependency notices | Exact installed texts and [index](../third_party/manifest.json) | Platform/native/bundle gaps and actual redistribution obligations |

The public tutorials exclude two unresolved MMAU-derived benchmark examples.
MMAU import/adapters remain supported for datasets users are authorized to use.
Archived examples remain in the private development repository only; no old refs
are imported into the public repository. Omitting files does not erase history.

The separately audited prototype ref contains historical personal contact/media
material outside current HEAD ancestry. The approved strategy retains that repository privately and creates a separate
curated public source repository. No history rewrite or old-ref publication is
authorized by this release.

Historical Flite/SLT speech provenance/notices were found on that prototype branch;
they do not establish CC0 for its output. None of those WAVs or voice models belongs
to the intended current public source set. OpenAI Sites/shadcn historical notices
remain evidence for that older material; they do not license the whole AudioLab
application. Retain applicable notices if any such material is distributed.
