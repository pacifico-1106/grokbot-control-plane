/** Migration 20261009700000 contract: names the data layer calls, privileges, rollback, no content columns. */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migrationPath = `${root}supabase/migrations/20261009700000_slack_skipped_channel_wakes.sql`;
const rollbackPath = `${root}supabase/verification/20261009700000_slack_skipped_channel_wakes_rollback.sql`;
const dataPath = `${root}lib/data/slack-skipped-wakes.ts`;

describe("slack skipped channel wakes migration", () => {
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
    const rpcs = [...data.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual(["claim_slack_skipped_channel_wakes", "record_slack_skipped_channel_wake"]);
    for (const rpc of rpcs) {
      expect(sql).toContain(`create or replace function public.${rpc}(`);
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${rpc}\\([^)]*\\) from public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${rpc}\\([^)]*\\) to service_role;`));
    }
    expect(sql).not.toMatch(/security definer/i);
    expect(sql).toContain("alter table public.slack_skipped_channel_wakes enable row level security;");
    expect(sql).toContain("revoke all on table public.slack_skipped_channel_wakes from public, anon, authenticated;");
    expect(sql).not.toMatch(/create policy/i);
  });

  test("ids and timestamps only: no text / body / token column", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const table = sql.slice(sql.indexOf("create table if not exists public.slack_skipped_channel_wakes"));
    const cols = table.slice(0, table.indexOf(");")).toLowerCase();
    for (const banned of [" text_", "body", "message", "token", "summary", "content"]) expect(cols).not.toContain(banned);
  });

  test("21:53 (2): the claim checks the approval is THIS channel's classification ticket (tool + externalId)", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const claim = sql.slice(sql.indexOf("create or replace function public.claim_slack_skipped_channel_wakes("));
    expect(claim).toContain("ar.tool = 'channels.classify'");
    expect(claim).toContain("ar.metadata->'adminMutation'->>'externalId' = p_channel");
    expect(claim).toContain("ar.tool = 'config.change_request'");
    expect(claim).toContain("'channel_classification'");
  });
});
