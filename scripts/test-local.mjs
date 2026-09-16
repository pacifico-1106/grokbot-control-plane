import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Never inherit service keys, provider tokens, or Bun's automatic .env loading.
const env = Object.fromEntries(["PATH", "TMPDIR", "TEMP", "SystemRoot"].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
Object.assign(env, { NODE_ENV: "test", NEXT_PUBLIC_STAFFPASS_DEMO_MODE: "true" });
const bun = process.env.BUN_BIN || "bun";
function tests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? tests(`${dir}/${entry.name}`) :
      entry.name.endsWith(".test.ts") ? [`${dir}/${entry.name}`] : []);
}
const files = process.argv.slice(2).length ? process.argv.slice(2) : [...tests("lib"), ...tests("app")];
let failed = 0;
for (const file of files.sort()) {
  const result = spawnSync(bun, ["--no-env-file", "test", "--preload", resolve("tests/security/no-network.ts"), resolve(file)], { env, stdio: "inherit" });
  if (result.status !== 0) failed++;
}
console.log(`Local test files: ${files.length - failed} passed, ${failed} failed. Environment files disabled.`);
process.exitCode = failed ? 1 : 0;
