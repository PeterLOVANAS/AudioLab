# Security reporting

Supported target: v1.0.0. No fixed support window is promised. Two-identity workers.dev staging acceptance passed;
this does not establish three-labeller live, sustained-load or extended recovery
acceptance. Follow the deployment and authentication guides for the verified scope.

Do not post credentials, private audio, annotations or an exploitable production
report in a public issue. Contact a known maintainer privately through the hosting
platform's **Report a vulnerability** feature on this repository's Security tab:
https://github.com/PeterLOVANAS/AudioLab/security/advisories/new. If that feature
is temporarily unavailable, use an already trusted private maintainer channel.
Do not send sensitive details to a guessed email address. No response SLA is claimed.

Provide affected revision/configuration, synthetic reproduction, expected/observed
behavior and scope without tokens or real datasets. For an exposed credential,
coordinate revocation/rotation with its owner before sharing redacted evidence.
Do not probe unrelated/live installations, rewrite history or delete research
records to demonstrate an issue.

Operators: follow [authentication](docs/AUTHENTICATION.md) for linked identities,
roles/revocation and [deployment](docs/DEPLOYMENT.md) for canonical origin, private
R2 and backup/recovery. Local DEV auth must never become a production fallback.
