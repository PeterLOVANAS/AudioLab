# v1.0.0 release checklist and source packaging

This is a preparation runbook, not authorization to push, merge, tag, deploy,
create a public repository or publish. The package version is prepared as 1.0.0
with `private:true`; there is no npm publication workflow.

## Required decisions

| Gate | Current requirement |
| --- | --- |
| Final human acceptance | Review the exact selected revision, record audible playback and approve the demonstration |
| Actual Cloudflare staging | Two-identity workers.dev acceptance passed; retain evidence for the deployed revision. Three-labeller live testing, custom-domain/rotation/recovery and load checks remain separate |
| Hosted GitHub Actions | Run the checks and browser jobs on the exact proposed integration revision; local macOS evidence is separate |
| Source license | Apache 2.0 approved; maintainer confirmed source/contributor authority; preserve LICENSE and NOTICE |
| Contributors/copied code | Maintainer confirmed authority; retain role-based acknowledgements and original history privately |
| Third-party obligations | Preserve notices and review components actually shipped; source archives omit installed/native/bundled build artifacts |
| Public repository/history | Approve the destination and exposed refs/history; do not change the private development repository's visibility |
| Security channel | Approve and enable a private reporting channel; see SECURITY.md |
| Final selection | Review RELEASE_FILES.json and its private hash audit; no held media, credentials, research state or internal evidence |
| Final revision/archive | Approve the commit/tag, verify the source tree and rebuild the final archive from that exact committed revision |

The technical source candidate can be tested privately before these gates close.
The root Apache 2.0 license covers original AudioLab source.
Dataset CC0 applies only to the bundled mathematical tones, not all source/UI.

## Verify a disposable candidate

Use the approved explicit file selection, without the existing Git database,
node_modules, build output or research state. Extract into a new directory and run:

```sh
pnpm install --frozen-lockfile
python3.11 -m venv /path/to/new-private-venv
. /path/to/new-private-venv/bin/activate
python -m pip install -r scripts/requirements.txt
python -m pip check
pnpm run docs:check
pnpm run test:regressions
pnpm run test:python
pnpm run typecheck
pnpm run build
node scripts/test_production_config.mjs
AUDIOLAB_TEST_PYTHON=python pnpm run test:production
AUDIOLAB_BROWSER_CHANNEL=chromium pnpm run test:acceptance
```

The browser command needs installed matching Chromium:
`pnpm exec playwright-core install chromium` (Linux CI also uses `--with-deps`).
The runner refuses a busy port 5202; never stop an unrelated server. Existing local
port 5173 and preserved research state are not acceptance inputs. Test data are
synthetic with disposable D1/R2 and private generated accounts. Keep logs/state
private; do not upload the complete test root or record credentials.

## Repository strategy and integration

A private integration PR into the development repository's main is separate from
publication. That history still contains historical benchmark/internal/personal
material. A source-only curated public repository, preserving the original privately,
is recommended subject to maintainer/contributor approval. Do not mirror/import old
Git refs to implement that strategy. Preserve approved attribution and notices.

After approving the concrete changed paths, stage only the explicit selection,
inspect the staged diff and commit on the agreed release branch. Refresh remote
main read-only before proposing a PR; cached origin/main is dated evidence. Push
only that approved branch and open the reviewed PR. Let hosted checks finish;
merge strategy and the resulting target commit need separate review/approval.
No all-branches push, force push, automatic merge or history rewrite.

If a curated repository is selected, separately approve its creation, private
source-only import, contributor credit and subsequent public visibility. It has
its own reviewed main/release history. Private-development commit hashes and
public-import commit hashes need not be identical; compare selected source trees.

## Final annotated tag, archive and checksum — after approval only

These commands are intentionally not part of CI. Run in the APPROVED publication
repository, after its reviewed main contains the release and all gates above close.
Before approving that final commit, finalize the proposed notes and any newly
authorized license/credits/status text, then recheck the selection. Do not edit
source documentation after tagging and imply those edits were part of the tag.
`APPROVED_COMMIT` must be the exact maintainer-approved full commit hash, not an
unreviewed working tree, cached branch name or candidate-archive receipt.

```sh
git status --short
APPROVED_COMMIT=REPLACE_WITH_APPROVED_FULL_COMMIT_HASH
git show --no-patch --format=fuller "$APPROVED_COMMIT"
git diff --exit-code "$APPROVED_COMMIT" --
# Review tracked/untracked paths and gates before executing these mutations.
git tag -a v1.0.0 "$APPROVED_COMMIT" -m 'AudioLab v1.0.0'
# Explicit tag only, and only to the approved destination:
git push origin refs/tags/v1.0.0
```

Build the final source ZIP from that commit using Git, not a recursive ZIP of a
working installation. Choose a new empty output directory outside the repository:

```sh
OUT=/absolute/path/to/new-release-output
mkdir -p "$OUT"
RELEASE_COMMIT="$(git rev-parse 'v1.0.0^{commit}')"
git archive --format=zip --prefix=AudioLab-1.0.0/ \
  --output="$OUT/AudioLab-v1.0.0-source.zip" "$RELEASE_COMMIT"
python - "$OUT/AudioLab-v1.0.0-source.zip" <<'PY'
import hashlib, pathlib, sys, zipfile
archive = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(archive.suffix + '.sha256').write_text(checksum + '  ' + archive.name + '\n')
PY
```

Verify the archive's selected paths against `RELEASE_FILES.json` read from the SAME
release commit, including any newly approved LICENSE/credits/notices. Review regular
file permissions, hashes and forbidden content. If the commit contains extra private
paths, STOP and correct the reviewed source selection; a ZIP filter does not make
unsafe public Git history private. Extract the archive and repeat the supported
checks where final source changes invalidate earlier evidence. Record full commit,
Git tree, archive SHA-256, file-selection hash and exact test evidence privately.
GitHub's automatically generated source archives are separate artifacts; attach
the checked named ZIP and checksum explicitly.

Only after release publication is authorized:

```sh
PUBLIC_REPOSITORY=REPLACE_WITH_APPROVED_OWNER_AND_REPOSITORY
gh release create v1.0.0 --repo "$PUBLIC_REPOSITORY" --verify-tag \
  --title 'AudioLab v1.0.0' --notes-file RELEASE_NOTES.md \
  "$OUT/AudioLab-v1.0.0-source.zip" "$OUT/AudioLab-v1.0.0-source.zip.sha256"
```

Finalize the proposed notes' publication/license/status text only after those
claims are approved and verified. Never upload private release reports, import
reports, operator manifests, credentials, D1/R2 state or real research screenshots.
