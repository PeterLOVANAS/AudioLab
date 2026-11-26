/** Refuse accidental local/demo deployment before invoking the installed tool.
 * This entrypoint performs no provisioning or migrations. Running it is a live
 * operation requiring maintainer approval; --check only validates local inputs.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { deploymentEnvironment } from "../lib/config/deployment.ts";
try {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const config = deploymentEnvironment(process.env);
  if (!config.deployed)
    throw new Error(
      "Set explicit AUDIOLAB_ENV=staging or production; local deployment is disabled.",
    );
  if (process.argv.slice(2).some((arg) => arg !== "--check"))
    throw new Error(
      "Only --check is accepted; deployment always rebuilds validated source.",
    );
  if (config.hostMode === "workers-dev")
    console.warn(
      "workers.dev: operator-confirmed Worker-level Access All traffic is required. This preflight does not verify cloud policies; live URL/CLI acceptance remains mandatory.",
    );
  if (process.argv.includes("--check"))
    console.log(
      `Deployment configuration valid: ${config.target}. No cloud calls performed.`,
    );
  else {
    const result = spawnSync(
      resolve(repo, "node_modules/.bin/vinext-cloudflare"),
      ["deploy", "--env", config.target],
      { cwd: repo, stdio: "inherit", env: process.env },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
