import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
// A production-mode build against synthetic/demo data. Refuse dotenv files;
// Next must never discover real credentials from a developer checkout.
if (readdirSync(process.cwd()).some(name => name.startsWith(".env") && !name.endsWith(".example"))) {
  throw new Error("Run this build in an isolated checkout without dotenv files");
}
const env = Object.fromEntries(["PATH", "TMPDIR", "TEMP"].flatMap(k => process.env[k] ? [[k,process.env[k]]] : []));
Object.assign(env, { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" });
const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], { env, stdio: "inherit" });
process.exitCode = result.status ?? 1;
