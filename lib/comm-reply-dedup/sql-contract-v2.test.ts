/**
 * Duplicate post guard v2 migration contract (static): additive / re-applicable,
 * after every existing migration, hashes only, service_role only, rollback.
 * The executable checks live in tests/security/db-duplicate-guard-v2.sql
 * (scripts/test-db-local.py).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(process.cwd(), "supabase/migrations");
const NAME = "20261005300000_duplicate_post_guard_v2.sql";
const ROLLBACK = resolve(process.cwd(), "supabase/verification/20261005300000_duplicate_post_guard_v2_rollback.sql");

describe("duplicate post guard v2 migration", () => {
  const sql = existsSync(resolve(DIR, NAME)) ? readFileSync(resolve(DIR, NAME), "utf8") : "";
  test("exists, has a unique timestamp, and sorts after main + PR-B #276 (20261005200000)", () => {
    const stamped = readdirSync(DIR).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(stamped).toContain(NAME);
    for (const f of stamped) if (f.slice(0, 14) <= "20261005200000") expect(f < NAME).toBe(true);
    expect(stamped.filter((f) => f.startsWith("20261005300000_"))).toEqual([NAME]);
    // PR-B #276 already uses 20261005200000; no two migrations may share a 14-digit prefix.
    const prefixes = stamped.map((f) => f.slice(0, 14));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
  test("additive: new nullable hash columns, no body column, re-applicable DDL", () => {
    expect(sql).toMatch(/add column if not exists channel_key text/);
    expect(sql).toMatch(/add column if not exists job_key text/);
    const added = [...sql.matchAll(/add column if not exists (\w+)/g)].map((m) => m[1]).sort();
    expect(added).toEqual(["channel_key", "job_key"]);
    expect(sql).toMatch(/'sns\.publish'/);
    expect(sql).not.toMatch(/drop table/);
  });
  test("RPCs: security invoker, fixed search_path, service_role only", () => {
    for (const fn of ["claim_outbound_send_v2", "release_uncertain_outbound_send"]) {
      const body = sql.slice(sql.indexOf(`create or replace function public.${fn}`));
      expect(body).toMatch(/security invoker set search_path = pg_catalog, public/);
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
    }
  });
  test("channel-level advisory lock (cross-thread / cross-employee claims serialize)", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\(\s*'outbound_send:' \|\| p_org::text \|\| ':' \|\| p_channel_key/);
  });
  test("rollback exists and restores the v1 tool list", () => {
    expect(existsSync(ROLLBACK)).toBe(true);
    const rb = existsSync(ROLLBACK) ? readFileSync(ROLLBACK, "utf8") : "";
    expect(rb).toMatch(/drop function if exists public\.claim_outbound_send_v2/);
    expect(rb).toMatch(/drop column if exists channel_key/);
    expect(rb).toMatch(/check \(tool in \('comm\.reply', 'comm\.send', 'slack\.post', 'slack\.post_external'\)\)/);
    expect(sql).toMatch(/-- Rollback/);
  });
});
