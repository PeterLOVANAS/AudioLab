/** Pure configuration/deployment preflight tests; no cloud operations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { deploymentEnvironment } from "../lib/config/deployment.ts";
import { parseAccessConfiguration } from "../lib/config/access.ts";
const valid = {
  AUDIOLAB_ENV: "staging",
  AUDIOLAB_AUTH_MODE: "access",
  APP_ORIGIN: "https://audio.example",
  ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
  ACCESS_AUDIENCE: "test-app",
  AUDIOLAB_WORKER_NAME: "audiolab-staging",
  AUDIOLAB_D1_ID: crypto.randomUUID(),
  AUDIOLAB_D1_NAME: "audiolab-staging",
  AUDIOLAB_R2_BUCKET: "audiolab-staging-private",
};
assert.equal(deploymentEnvironment({}).deployed, false);
assert.equal(deploymentEnvironment(valid).hostname, "audio.example");
assert.equal(deploymentEnvironment(valid).workersDev, false);
assert.equal(
  deploymentEnvironment({ ...valid, AUDIOLAB_ENV: "production" }).hostMode,
  "custom-domain",
);
const workersDev = {
  ...valid,
  AUDIOLAB_HOST_MODE: "workers-dev",
  AUDIOLAB_WORKERS_SUBDOMAIN: "isolated-account",
  APP_ORIGIN: "https://audiolab-staging.isolated-account.workers.dev",
  AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED: "true",
};
assert.equal(deploymentEnvironment(workersDev).workersDev, true);
assert.equal(
  parseAccessConfiguration(deploymentEnvironment(workersDev).auth).origin,
  workersDev.APP_ORIGIN,
);
for (const patch of [
  { AUDIOLAB_ENV: "production" },
  { AUDIOLAB_ENV: "local" },
  { AUDIOLAB_HOST_MODE: "typo" },
  { AUDIOLAB_WORKERS_SUBDOMAIN: "" },
  { AUDIOLAB_WORKERS_SUBDOMAIN: "other-account" },
  { AUDIOLAB_WORKERS_SUBDOMAIN: "bad.account" },
  { AUDIOLAB_WORKERS_SUBDOMAIN: "-account" },
  { AUDIOLAB_WORKER_NAME: "wrong-worker" },
  { AUDIOLAB_WORKER_NAME: "trailing-" },
  { AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED: "" },
  { AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED: "false" },
  { AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED: "True" },
  { APP_ORIGIN: "http://audiolab-staging.isolated-account.workers.dev" },
  { APP_ORIGIN: workersDev.APP_ORIGIN + "/" },
  { APP_ORIGIN: workersDev.APP_ORIGIN + ":8443" },
  {
    APP_ORIGIN:
      "https://audiolab-staging.isolated-account.workers.dev.attacker.example",
  },
  {
    APP_ORIGIN: "https://preview-audiolab-staging.isolated-account.workers.dev",
  },
  {
    APP_ORIGIN: "https://version-audiolab-staging.isolated-account.workers.dev",
  },
  { APP_ORIGIN: "https://audio.example" },
  { APP_ORIGIN: "https://test.workers.dev" },
  { AUDIOLAB_AUTH_MODE: "demo" },
  { ACCESS_AUDIENCE: "" },
])
  assert.throws(
    () => deploymentEnvironment({ ...workersDev, ...patch }),
    JSON.stringify(patch),
  );
for (const patch of [
  { AUDIOLAB_WORKERS_SUBDOMAIN: "stale-account" },
  { AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED: "true" },
])
  assert.throws(() => deploymentEnvironment({ ...valid, ...patch }));
assert.equal(
  parseAccessConfiguration(deploymentEnvironment(valid).auth).origin,
  "https://audio.example",
);
for (const patch of [
  { AUTH_MODE: "demo" },
  { ACCESS_TEAM_DOMAIN: "https://evil.example" },
  { ACCESS_AUDIENCE: "" },
  { APP_ORIGIN: "https://audio.example/path" },
]) {
  assert.throws(() =>
    parseAccessConfiguration({
      ...deploymentEnvironment(valid).auth,
      ...patch,
    }),
  );
}
for (const name of [
  "APP_ORIGIN",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUDIENCE",
  "AUDIOLAB_WORKER_NAME",
  "AUDIOLAB_D1_ID",
  "AUDIOLAB_D1_NAME",
  "AUDIOLAB_R2_BUCKET",
])
  assert.throws(() => deploymentEnvironment({ ...valid, [name]: "" }), name);
for (const [name, value] of [
  ["AUDIOLAB_ENV", "typo"],
  ["AUDIOLAB_AUTH_MODE", "demo"],
  ["AUDIOLAB_AUTH_MODE", "typo"],
  ["APP_ORIGIN", "https://audio.example/path"],
  ["APP_ORIGIN", "https://user:secret@audio.example"],
  ["APP_ORIGIN", "https://audio.example/"],
  ["APP_ORIGIN", "https://audio.example:8443"],
  ["APP_ORIGIN", "https://localhost"],
  ["APP_ORIGIN", "https://test.workers.dev"],
  ["ACCESS_TEAM_DOMAIN", "https://evil.example"],
  ["AUDIOLAB_D1_ID", "11111111-1111-4111-8111-111111111111"],
])
  assert.throws(
    () => deploymentEnvironment({ ...valid, [name]: value }),
    `${name}=${value}`,
  );
for (const [env, status] of [
  [{ AUDIOLAB_ENV: "local" }, 1],
  [valid, 0],
  [workersDev, 0],
  [{ ...workersDev, AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED: "false" }, 1],
]) {
  const result = spawnSync(
    process.execPath,
    ["scripts/deploy.mjs", "--check"],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );
  assert.equal(result.status, status, result.stderr);
  if (!status) assert(result.stdout.includes("No cloud calls"));
}
// Inspect the actual pinned cf config, not only the pure helper. Clear inherited
// operator settings per case; importing configuration performs no cloud calls.
const keys = new Set([...Object.keys(valid), ...Object.keys(workersDev)]);
const original = Object.fromEntries(
  [...keys].map((key) => [key, process.env[key]]),
);
try {
  for (const [index, values] of [
    valid,
    workersDev,
    { ...valid, AUDIOLAB_ENV: "production" },
    { AUDIOLAB_ENV: "local" },
  ].entries()) {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    const config = (await import(`../cloudflare.config.ts?host-case=${index}`))
      .default;
    const worker = config.worker;
    assert.equal(worker.previewUrls, false);
    assert.equal(worker.workersDev, values === workersDev);
    assert.deepEqual(
      worker.domains,
      values === workersDev || values.AUDIOLAB_ENV === "local"
        ? undefined
        : ["audio.example"],
    );
  }
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
console.log(
  "PASS local/deployed config separation, required resources, exact HTTPS origin, demo/placeholder rejection and no-network deploy preflight",
);
console.log(
  "PASS explicit staging-only workers.dev, exact Worker/account origin, Access operator gate, unchanged production defaults and actual cf routing/preview configuration; no cloud policy verified.",
);
