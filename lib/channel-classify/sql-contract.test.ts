/** Migration 20261005200000 contract: names the data layer calls, privileges, rollback. */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migrationPath = `${root}supabase/migrations/20261005200000_channel_classify_proposals.sql`;
const rollbackPath = `${root}supabase/verification/20261005200000_channel_classify_proposals_rollback.sql`;
const dataPath = `${root}lib/data/channel-classify.ts`;

describe("channel classify migration", () => {
  test("exists with a ROLLBACK block and a rollback file", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(existsSync(rollbackPath)).toBe(true);
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(/^-- ROLLBACK \(down\)/m);
    expect(sql).toMatch(/^-- END ROLLBACK/m);
  });

  test("every RPC the data layer calls is created, revoked from sessions and granted to service_role only", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const data = readFileSync(dataPath, "utf8");
    const rpcs = [...data.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(rpcs.sort()).toEqual([
      "attach_channel_classify_proposal",
      "claim_channel_classify_proposal",
      "release_channel_classify_proposal",
      "take_channel_stuck_notice",
    ]);
    for (const rpc of rpcs) {
      expect(sql).toContain(`create or replace function public.${rpc}(`);
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${rpc}\\([^)]*\\) from public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${rpc}\\([^)]*\\) to service_role;`));
    }
    expect(sql).not.toMatch(/security definer/i);
    for (const table of ["channel_classify_proposals", "channel_stuck_notice_windows"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`revoke all on table public.${table} from public, anon, authenticated;`);
    }
  });

  test("org_channels surface check gains telegram only; rollback restores the previous list", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("check (surface in ('slack','line','mail','phone','web','telegram'))");
    const rollback = readFileSync(rollbackPath, "utf8");
    expect(rollback).toContain("check (surface in ('slack','line','mail','phone','web'))");
    expect(rollback).toContain("delete from public.org_channels where surface = 'telegram'");
  });
});
