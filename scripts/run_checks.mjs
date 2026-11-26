/** Run the supported offline regressions without hiding individual failures.
 * Production HTTP tests require a completed build and have their own command.
 * Historical *_http.py lesson scripts require older fixtures and are not units.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const mode = process.argv[2];
if (!["js", "python"].includes(mode)) throw Error("Choose js or python");
const files = mode === "js"
  ? readdirSync("scripts").filter(name => /^test_.*\.cjs$/.test(name) && name !== "test_production_security.cjs").sort()
  : ["test_access_tooling.py", "test_local_admin_api.py", "test_universal_import.py", "test_local_setup.py", "test_import_labellers.py"];
let failures = 0;
for (const file of files) {
  const executable = mode === "js" ? process.execPath : process.env.AUDIOLAB_TEST_PYTHON || "python3";
  const args = mode === "js" ? ["scripts/" + file] : ["-B", "scripts/" + file];
  const result = spawnSync(executable, args, { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  const passed = result.status === 0;
  if (!passed) failures++;
  console.log(`${passed ? "PASS" : "FAIL"} ${file}`);
}
console.log(`${files.length - failures}/${files.length} supported ${mode} scripts passed`);
process.exitCode = failures ? 1 : 0;
