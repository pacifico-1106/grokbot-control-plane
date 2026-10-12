/**
 * 決定 3 / H5: comm-account secrets never pass through AI or Admin MCP. No module
 * reachable from an AI tool call (gateway, MCP, Admin MCP) may import the account
 * store or the secret crypto. The tenant UI / API (added later) is the only writer.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const AI_REACHABLE = ["lib/gateway", "lib/mcp", "lib/admin-mcp", "app/api/mcp", "app/api/gateway", "app/api/admin-mcp"];
const FORBIDDEN = /["'](?:@\/|(?:\.\.?\/)+)(?:lib\/)?comm\/(?:accounts|secret-crypto)["']/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe("comm account secrets are not reachable from AI tool paths", () => {
  test("no AI-reachable module imports lib/comm/accounts or lib/comm/secret-crypto", () => {
    const offenders = AI_REACHABLE.flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
  test("the pattern catches the import forms", () => {
    for (const s of [`from "@/lib/comm/accounts"`, `import("@/lib/comm/secret-crypto")`, `from "../comm/accounts"`, `require('../../lib/comm/accounts')`]) {
      expect(FORBIDDEN.test(s)).toBe(true);
    }
    expect(FORBIDDEN.test(`from "@/lib/comm/flags"`)).toBe(false);
  });
});
