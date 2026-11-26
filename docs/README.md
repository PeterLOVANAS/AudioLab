# Public documentation

Start with the [project README](../README.md) and the bundled
[synthetic CC0 example](../examples/datasets/synthetic/README.md).
The guides follow four primary topics:

| Topic | Guides |
| --- | --- |
| Local and Cloudflare deployment | [Local installation, initialization and restart](22_FRESH_LOCAL_SETUP.md), [Cloudflare deployment, backup and recovery](DEPLOYMENT.md), [authentication](AUTHENTICATION.md) |
| Dataset and labeller management | [Canonical manifest, references, adapters, import/inspect/retry](23_DATASET_INGESTION.md), [labeller accounts, teams and assignment walkthrough](WORKFLOW.md) |
| Requirements, backend and database | [Prerequisites and migrations](22_FRESH_LOCAL_SETUP.md), [architecture/data relationships](ARCHITECTURE.md), [HTTP API](API.md), [testing/CI](TESTING.md) |
| Features and conceptual design | [Annotation workflow](WORKFLOW.md), [results, agreement, IoU and export](RESULTS.md), [demonstration/manual QA](DEMONSTRATION.md), [limitations](KNOWN_LIMITATIONS.md) |

Release administrators: [proposed release notes](../RELEASE_NOTES.md),
[final checklist and packaging](RELEASING.md), [license status](LICENSE_STATUS.md)
and [provenance](PROVENANCE.md). The source license and publication destination
remain subject to maintainer/contributor approval.

Numbered historical implementation plans, `docs/evidence/`, `docs/release/`, agent
handoffs, educational notes and presentation/operator folders are private development
evidence. Their local copies remain preserved; they are not public feature promises.
The curated `docs/images/` selection contains only verified synthetic-data screenshots.
