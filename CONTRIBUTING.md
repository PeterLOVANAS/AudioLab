# Contributing

AudioLab v1.0.0 is a source release under Apache 2.0; see
[license scope](docs/LICENSE_STATUS.md). Do not submit third-party content without
permission. Discuss changes before starting new feature work.

Discuss scope before starting feature work. Preserve existing React/TypeScript,
Vinext/Workers, D1/R2, canonical v1 and revision/version models. Fix verified
release blockers with bounded changes and intent/contract comments. Validate on
the server; never use UI role visibility or supplied IDs as authorization.

Use [installation](docs/22_FRESH_LOCAL_SETUP.md) and [tests](docs/TESTING.md).
Never reset another person's state. Use a new disposable root and synthetic data;
never commit `.env`, credentials, private source labels, research media, databases,
generated output or browser session traces. Confirm rights before adding assets.

For a review, explain the problem/resulting behavior, exact changed files, tests
executed, data/permission implications and limitations. Run focused tests, the
supported release commands where affected, typecheck and build. Preserve teammate
work and published definition/annotation immutability. Use one honest logical
commit where edits cannot safely be split; do not fabricate historical phase
commits. Git/publication/deployment actions require maintainer authorization.

Identify copied code's upstream revision/license and retain required notices.
Confirm contribution ownership, including employer/course restrictions, and the
Apache 2.0 terms with maintainers before contribution. Provide preferred public
acknowledgement names without private contact information.
