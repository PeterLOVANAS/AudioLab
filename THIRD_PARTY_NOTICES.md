# Third-party notices and unresolved provenance

Original AudioLab source is covered by the root Apache 2.0 LICENSE. Upstream
licenses continue to govern their own covered material. [License status](docs/LICENSE_STATUS.md).

[third_party/manifest.json](third_party/manifest.json) maps exact locally inspected
locked package versions to byte-preserved upstream license/NOTICE texts under
`third_party/licenses/`. Files are deduplicated by SHA-256, without changing their
copyright/contact/attribution content. The index includes 205 npm package versions
and five Python distributions. It is not a claim that each is shipped in a source
archive or that metadata alone clears a compiled binary.

Direct runtime dependencies declare MIT (React, React DOM/RSC, Vinext/Cloudflare,
jose, Zod) or ISC (Lucide). Build/test dependencies include MIT, Apache 2.0 and dual
terms. Transitives include MPL-2.0 (resvg, satori, Vercel OG, lightningcss), LGPL
libvips, CC-BY caniuse data and CC0 speed-highlight. Python Requests includes Apache
NOTICE; certifi is MPL; charset-normalizer/urllib3 MIT and idna BSD-3-Clause.

Review before distribution:

- Preserve applicable copyright/license/NOTICE/attribution requirements for
  included code/data. AudioLab's license cannot replace upstream terms.
- Seventeen locally inspected npm packages lack a root notice file in their
  installed folder; 83 other-platform lock entries were not locally inspected.
  They are explicitly flagged in the index, not silently marked cleared.
- Native/WASM/Worker bundles can have additional component/source/linking obligations.
  Review the actual included components and supply necessary source/notices before
  distributing such artifacts. Source ZIPs exclude `node_modules` and build output.
- The maintainer confirmed original prototype/workbench and teammate contribution
  authority for Apache 2.0. [Provenance](docs/PROVENANCE.md).
- No Flite executable/voice model or historical prototype WAV is included in the
  intended public source set. Do not relabel historical Flite speech or benchmark
  content as CC0. The current CC0 example dedication is dataset-scoped.

Official terms: [MIT](https://opensource.org/license/mit),
[Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0),
[MPL](https://www.mozilla.org/en-US/MPL/2.0/FAQ/),
[CC BY](https://creativecommons.org/licenses/by/4.0/),
[CC0](https://creativecommons.org/publicdomain/zero/1.0/).
These references and preserved texts inform maintainer review; they are not a
legal clearance for every possible downstream bundle or binary.
