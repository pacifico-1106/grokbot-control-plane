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

function usesRawAppendForAdmin(text: string): boolean {
  if (!/\bappendAuditEvent\s*\(/.test(text)) return false;
  const chunks = text.split("appendAuditEvent(").slice(1);
  return chunks.some((chunk) => {
    const head = chunk.slice(0, 800);
    return /action:\s*["'`]admin\./.test(head) || /action:\s*auditAction\b/.test(head);
  });
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
      expect(src).toBeTruthy();
      expect(src!.text).toContain("appendAdminAuditEvent");
    }
  });

  test("automatic Slack audit paths pass an explicit actor", () => {
    const slack = sources.filter(
      (s) =>
        s.path.startsWith("lib/slack/") ||
        s.path === "lib/admin-mcp/slack-approver.ts" ||
        s.path === "lib/admin-mcp/slack-dm-setup.ts" ||
        s.path === "lib/notify/delivery-failure-alert.ts"
    );
    const bare = slack.flatMap((s) => {
      const hits: string[] = [];
      const re = /resolveAdminAuditActor\(\{([^}]*)\}\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s.text))) {
        const args = m[1];
        const hasExplicit =
          /\bcred\b/.test(args) ||
          /\bhuman\b/.test(args) ||
          /\bapproval\b/.test(args) ||
          /\bfallbackHuman\b/.test(args);
        if (!hasExplicit) hits.push(`${s.path}: ${args.trim()}`);
      }
      return hits;
    });
    expect(bare).toEqual([]);
  });
});
