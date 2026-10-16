/**
 * Every production write of an admin.* audit action must go through
 * appendAdminAuditEvent so missing actorKind / key identity fails the build.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HELPER = "lib/audit/admin-audit.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const sources = ["lib", "app"]
  .flatMap((d) => walk(join(ROOT, d)))
  .map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }))
  .filter((s) => s.path !== HELPER);

function literalAdminWrites(text: string): number {
  return (
    (text.match(/action:\s*["'`]admin\.[A-Za-z0-9_]+["'`]/g) || []).length
  );
}

function usesRawAppendForAdmin(text: string): boolean {
  if (!text.includes("appendAuditEvent")) return false;
  if (literalAdminWrites(text) === 0 && !text.includes("auditActionForAdminTool")) {
    return false;
  }
  const usesHelper = text.includes("appendAdminAuditEvent");
  if (usesHelper && !/\bappendAuditEvent\s*\(/.test(text)) return false;
  if (usesHelper) {
    // Helper is present; still fail if a raw appendAuditEvent writes admin.*.
    const chunks = text.split("appendAuditEvent(").slice(1);
    return chunks.some((chunk) => /action:\s*["'`]admin\./.test(chunk.slice(0, 400)));
  }
  return literalAdminWrites(text) > 0 || text.includes("auditActionForAdminTool");
}

describe("admin.* audit writes go through the shared helper", () => {
  test("no production file writes admin.* via raw appendAuditEvent", () => {
    const offenders = sources.filter((s) => usesRawAppendForAdmin(s.text)).map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  test("known admin write paths import the helper", () => {
    const required = [
      "app/api/admin-mcp/issue/route.ts",
      "app/api/admin-mcp/link/route.ts",
      "lib/admin-mcp/fulfill-admin.ts",
      "lib/admin-mcp/orgs-issue-admin-credential.ts",
      "lib/admin-mcp/queue.ts",
    ];
    for (const rel of required) {
      const src = sources.find((s) => s.path === rel);
      expect(src, rel).toBeTruthy();
      expect(src!.text, rel).toContain("appendAdminAuditEvent");
    }
  });
});
