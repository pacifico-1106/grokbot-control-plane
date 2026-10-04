/**
 * Migration contract (static): additive / reversible, after every existing
 * migration, superseded allowed, RLS on, service_role only, no body column.
 * The executable checks live in tests/security/db-comm-reply-dedup.sql
 * (scripts/test-db-local.py).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(import.meta.dir, "../../supabase/migrations");
const NAME = "20261004700000_comm_reply_dedup.sql";

describe("comm reply dedup migration", () => {
  const sql = readFileSync(resolve(DIR, NAME), "utf8");
  test("is the newest timestamped migration (after 20261004300000; leaves 400000–600000 to parallel PRs)", () => {
    const stamped = readdirSync(DIR).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(stamped[stamped.length - 1]).toBe(NAME);
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
  test("documents the rollback", () => {
    expect(sql).toMatch(/-- Rollback/);
  });
});
