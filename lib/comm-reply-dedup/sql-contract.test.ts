/**
 * Migration contract (static): additive / reversible, after every existing
 * migration, superseded allowed, RLS on, service_role only, no body column.
 * The executable checks live in tests/security/db-comm-reply-dedup.sql
 * (scripts/test-db-local.py).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(process.cwd(), "supabase/migrations");
const NAME = "20261004700000_comm_reply_dedup.sql";

describe("comm reply dedup migration", () => {
  const sql = readFileSync(resolve(DIR, NAME), "utf8");
  test("sorts after every earlier migration (300000 on main; 400000 / 500000 / 600000 are parallel PRs)", () => {
    // Not "the newest": later migrations must not break this test.
    const stamped = readdirSync(DIR).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(stamped).toContain(NAME);
    for (const earlier of ["20261004300000", "20261004400000", "20261004500000", "20261004600000"]) {
      expect(earlier < NAME.slice(0, 14)).toBe(true);
    }
    for (const f of stamped) if (f.slice(0, 14) <= "20261004600000") expect(f < NAME).toBe(true);
    // No other migration shares this timestamp (e.g. a parallel PR).
    expect(stamped.filter((f) => f.startsWith("20261004700000_"))).toEqual([NAME]);
  });
  test("adds superseded to approval_requests status (keeps every existing status)", () => {
    expect(sql).toMatch(/'pending',\s*'approved',\s*'rejected',\s*'expired',\s*'revision_requested',\s*'superseded'/);
  });
  test("ledger stores hashes only: no text/body/message column", () => {
    const table = sql.slice(sql.indexOf("create table if not exists public.comm_reply_send_fingerprints"));
    const ddl = table.slice(0, table.indexOf(");"));
    expect(ddl).not.toMatch(/\b(text_body|body|message|content)\s+text\b/);
    expect(ddl).toMatch(/body_hash text not null/);
  });
  test("RLS enabled; anon / authenticated revoked; service_role only for RPCs", () => {
    expect(sql).toMatch(/alter table public\.comm_reply_send_fingerprints enable row level security/);
    expect(sql).toMatch(/revoke all on table public\.comm_reply_send_fingerprints from public, anon, authenticated/);
    expect(sql).toMatch(/revoke all on function public\.claim_comm_reply_send\([^)]*\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.claim_comm_reply_send\([^)]*\) to service_role/);
  });
  test("fulfill re-check: replied_after_approval only for a similar / identical reply (木村, same criterion as duplicates)", () => {
    const claim = sql.slice(sql.indexOf("create or replace function public.claim_comm_reply_send"));
    const branch = claim.slice(claim.indexOf("if p_approval is not null then", claim.indexOf("pg_advisory_xact_lock")));
    const block = branch.slice(0, branch.indexOf("make_interval(secs => p_window_seconds)"));
    expect(block).toMatch(/'superseded'/);
    expect(block).toMatch(/f\.created_at > a_created/);
    expect(block).toMatch(/f\.body_hash = p_body_hash/);
    expect(block).toMatch(/p_similarity is not null and p_sketch is not null/);
    expect(block).toMatch(/'match'/);
  });
  test("documents the rollback", () => {
    expect(sql).toMatch(/-- Rollback/);
  });
});
