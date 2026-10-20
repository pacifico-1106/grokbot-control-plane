/**
 * Fail-first: TOKYO307 retire audit backfill SQL must not write across orgs.
 * Prefix match is tenant-scoped; COMMIT with empty org_id is a no-op; default is ROLLBACK.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL_PATH = resolve("supabase/verification/20261017100000_tokyo307_retire_audit_backfill.sql");
const DOC_PATH = resolve("docs/ops/tokyo307-retire-audit-backfill.md");

function uncommented(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const sql = readFileSync(SQL_PATH, "utf8");
const body = uncommented(sql);
const inserts = [...body.matchAll(/insert into public\.audit_events \([\s\S]*?;/gi)].map((m) => m[0]);

describe("TOKYO307 retire audit backfill SQL (tenant + idempotency)", () => {
  test("default is ROLLBACK; no executable COMMIT", () => {
    expect(sql.toLowerCase()).toContain("\nbegin;");
    expect(body.trimEnd().toLowerCase().endsWith("rollback;")).toBe(true);
    expect(body).not.toMatch(/\bcommit\s*;/i);
  });

  test("writes are audit_events INSERT only (no live credential / employee / oauth mutation)", () => {
    expect(body).not.toMatch(/\bupdate\s+public\.(credentials|employees|oauth_grants|oauth_access_tokens|oauth_refresh_tokens|mcp_event_subscriptions)\b/i);
    expect(body).not.toMatch(/\bdelete\s+from\s+public\.(credentials|employees|oauth_grants|audit_events)\b/i);
    expect(inserts.length).toBeGreaterThan(0);
    for (const stmt of inserts) {
      expect(stmt.toLowerCase()).toContain("insert into public.audit_events");
    }
  });

  test("prefix match cannot span another org (org_id required, no null-or bypass)", () => {
    expect(body).not.toMatch(/p\.org_id is null or c\.org_id = p\.org_id/i);
    expect(body).toMatch(/p\.org_id is not null/i);
    expect(body).toMatch(/c\.org_id = p\.org_id/i);
    expect(sql).toMatch(/array\['9e9bfc80',\s*'53d551f3',\s*'43b63187',\s*'0fd2f410'\]/);
  });

  test("prefix is 8 hex chars and over-match / cross-org blocks the write", () => {
    expect(body).toMatch(/pref\s*~\s*'?\^\[0-9a-f\]\{8\}\$'?/i);
    expect(body.toLowerCase()).toMatch(/count\(\*\)/);
    expect(body).toMatch(/having count\(\*\) <> 1/i);
    expect(body).toMatch(/count\(distinct org_id\)/i);
  });

  test("employee.terminated backfill requires revoked_at and status=suspended in this org", () => {
    const terminated = inserts.filter((s) => s.includes("'employee.terminated'"));
    expect(terminated.length).toBeGreaterThan(0);
    for (const stmt of terminated) {
      expect(stmt).toMatch(/revoked_at is not null/i);
      expect(stmt).toMatch(/employee_status = 'suspended'/);
      expect(stmt).toMatch(/p\.org_id is not null/i);
      expect(stmt).toMatch(/t\.org_id = p\.org_id/i);
    }
  });

  test("credential.revoked backfill is org-scoped and skipped if any same-action row exists (not only backfill=true)", () => {
    const revoked = inserts.filter((s) => s.includes("'credential.revoked'"));
    expect(revoked.length).toBeGreaterThan(0);
    for (const stmt of revoked) {
      expect(stmt).toMatch(/t\.revoked_at is not null/i);
      expect(stmt).toMatch(/p\.org_id is not null/i);
      expect(stmt).toMatch(/t\.org_id = p\.org_id/i);
      expect(stmt).toMatch(/a\.action = 'credential\.revoked'/);
      expect(stmt).not.toMatch(/metadata ->> 'backfill'[\s\S]* = true/);
    }
  });

  test("actor and metadata are human backfill (八坂 GO)", () => {
    expect(sql).toContain("'actor', 'human'");
    expect(sql).toContain("'backfill', true");
    expect(sql).toContain("p.actor_email");
    expect(sql).toContain("'goBy', p.go_by");
    expect(sql).toContain("'performedBy', p.performed_by");
    expect(sql).toMatch(/actor_email text not null/);
  });

  test("ops doc requires org_id before COMMIT (null prefix search is not a write path)", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    expect(doc).toMatch(/ROLLBACK/);
    expect(doc).not.toMatch(/不明なら `null` のまま prefix で探す/);
    expect(doc).toMatch(/org_id/);
    expect(doc).toMatch(/必須/);
  });
});
