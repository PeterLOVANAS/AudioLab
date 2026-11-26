# Historical migration compatibility fixture

`w01-workflow.sql.fixture` is an exact copy of
`migrations/0010_workflow_persistence.sql` at commit
`79e77929d5809d5fb8744772bdd465b7be8e7cab` on the audited workflow branch.
SHA-256: `4c7c0f1aec6a92909149602cae7a5539f8f8a76ec93223ef0e733c3ef9ffc33a`.

It is test input for `scripts/test_team_job_migrations.cjs`,
`test_assigned_bindings.cjs` and `test_candidate_sets.cjs`, which apply both
historical migration orders to in-memory SQLite. It is not a release migration,
workflow-engine implementation or instruction to migrate user data. Initialization
still uses only the 16 files under `migrations/`. The original reserved filename,
contents, commit and contributor history remain unchanged.

This copy removes a clean-checkout dependency on cached/private Git refs. Retain
its provenance; the maintainer confirmed authority to include this fixture under
AudioLab’s Apache 2.0 source license. Do not silently edit the bytes or add it to migration tooling.
