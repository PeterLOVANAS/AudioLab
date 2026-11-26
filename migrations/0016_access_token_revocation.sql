-- App-side logout revocation supplements the identity provider's logout.
-- Store only token digests; entries expire after the verifier's 24h maximum age.
CREATE TABLE auth_access_revocations (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_access_revocations_expiry ON auth_access_revocations(expires_at);
