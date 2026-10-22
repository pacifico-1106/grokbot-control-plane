/**
 * Fail-first: PR-6 actor_email backfill SQL stays per-org, empty-column-only,
 * and never writes email / hash / secrets into metadata.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION = resolve("supabase/migrations/20261022200000_audit_actor_email_backfill.sql");
const PREFLIGHT = resolve("supabase/verification/20261022200000_audit_actor_email_backfill_preflight.sql");
const APPLY = resolve("supabase/verification/20261022200000_audit_actor_email_backfill_apply.sql");
const VERIFY = resolve("supabase/verification/20261022200000_audit_actor_email_backfill_verify.sql");
const ROLLBACK = resolve("supabase/verification/20261022200000_audit_actor_email_backfill_rollback.sql");

function uncommented(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const migration = readFileSync(MIGRATION, "utf8");
const body = uncommented(migration);
const apply = uncommented(readFileSync(APPLY, "utf8"));
const rollback = uncommented(readFileSync(ROLLBACK, "utf8"));
const preflight = readFileSync(PREFLIGHT, "utf8");
const verify = readFileSync(VERIFY, "utf8");

const FLAG = "ADMIN_AUDIT_ACTOR_EMAIL_BACKFILL_ENABLED";
const FLAG_ORGS = "ADMIN_AUDIT_ACTOR_EMAIL_BACKFILL_ORG_IDS";
const ORG = "org_backfill_a";
const OTHER = "org_backfill_b";

describe("ADMIN_AUDIT_ACTOR_EMAIL_BACKFILL flag", () => {
  afterEach(() => {
    delete process.env[FLAG];
    delete process.env[FLAG_ORGS];
  });

  test("defaults OFF; empty org list is fail-closed (0 orgs)", async () => {
    delete process.env[FLAG];
    delete process.env[FLAG_ORGS];
    const {
      isAdminAuditActorEmailBackfillEnabled,
      isAdminAuditActorEmailBackfillEnabledForOrg,
    } = await import("@/lib/feature-flags");
    expect(isAdminAuditActorEmailBackfillEnabled()).toBe(false);
    expect(isAdminAuditActorEmailBackfillEnabledForOrg(ORG)).toBe(false);
    expect(isAdminAuditActorEmailBackfillEnabledForOrg(null)).toBe(false);
    expect(isAdminAuditActorEmailBackfillEnabledForOrg("")).toBe(false);

    process.env[FLAG] = "true";
    expect(isAdminAuditActorEmailBackfillEnabledForOrg(ORG)).toBe(false);
    expect(isAdminAuditActorEmailBackfillEnabledForOrg(OTHER)).toBe(false);
    expect(isAdminAuditActorEmailBackfillEnabledForOrg(null)).toBe(false);
  });

  test("ON + org allowlist is fail-closed to listed orgs only", async () => {
    process.env[FLAG] = "true";
    process.env[FLAG_ORGS] = ORG;
    const { isAdminAuditActorEmailBackfillEnabledForOrg } = await import("@/lib/feature-flags");
    expect(isAdminAuditActorEmailBackfillEnabledForOrg(ORG)).toBe(true);
    expect(isAdminAuditActorEmailBackfillEnabledForOrg(OTHER)).toBe(false);
    expect(isAdminAuditActorEmailBackfillEnabledForOrg(null)).toBe(false);
  });
});

describe("PR-6 actor_email backfill SQL (tenant + empty-only + mark)", () => {
  test("migration writes no audit_events rows (helpers only)", () => {
    expect(body).not.toMatch(/insert\s+into\s+public\.audit_events/i);
    expect(body).toMatch(/backfill_audit_actor_email_pr6_batch/i);
    expect(body).toMatch(/rollback_audit_actor_email_pr6_batch/i);
    expect(body).toMatch(/for update of a skip locked/i);
    expect(body).not.toMatch(/create or replace procedure/i);
  });

  test("every join is closed on org_id; null org raises", () => {
    expect(body).toMatch(/r\.org_id = a\.org_id/i);
    expect(body).toMatch(/m\.org_id = a\.org_id/i);
    expect(body).toMatch(/a\.org_id = p_org_id/i);
    expect(body).toMatch(/r\.org_id = p_org_id/i);
    expect(body).toMatch(/m\.org_id = p_org_id/i);
    expect(body).toMatch(/raise exception 'org_id_required'/i);
    expect(body).not.toMatch(/p_org_id is null or/i);
  });

  test("updates empty actor_email only and never touches secret columns", () => {
    const updates = [...body.matchAll(/update\s+public\.audit_events[\s\S]*?;/gi)].map((m) => m[0]);
    expect(updates.length).toBeGreaterThan(0);
    const fill = updates.filter((stmt) => /actor_email = src\.email/i.test(stmt));
    const undo = updates.filter((stmt) => /actor_email = null/i.test(stmt));
    expect(fill.length).toBeGreaterThan(0);
    expect(undo.length).toBeGreaterThan(0);
    for (const stmt of fill) {
      expect(stmt).toMatch(/audit_pr6_actor_email_empty/i);
    }
    for (const stmt of undo) {
      expect(stmt).toMatch(/metadata->>'backfill' = 'actor_email_pr6'/);
    }
    for (const stmt of updates) {
      expect(stmt).not.toMatch(/\bstatus_token\b/i);
      expect(stmt).not.toMatch(/\bpoll_path\b/i);
      expect(stmt).not.toMatch(/\bpollPath\b/);
      expect(stmt).not.toMatch(/\bstatusToken\b/);
    }
    expect(body).not.toMatch(/update\s+public\.approval_requests/i);
    expect(body).not.toMatch(/update\s+public\.org_members/i);
  });

  test("metadata mark is actor_email_pr6 only (no email, hash, or secret)", () => {
    expect(body).toMatch(/jsonb_build_object\('backfill',\s*'actor_email_pr6'\)/);
    expect(body).not.toMatch(/jsonb_build_object\('backfill',\s*true\)/);
    expect(body).not.toMatch(/md5\s*\(/i);
    expect(body).not.toMatch(/digest\s*\(/i);
    expect(body).not.toMatch(/sha256/i);
    const builds = [...body.matchAll(/jsonb_build_object\(([^)]*)\)/gi)].map((m) => m[1]);
    expect(builds.length).toBeGreaterThan(0);
    for (const args of builds) {
      expect(args).toMatch(/'backfill'/);
      expect(args).toMatch(/'actor_email_pr6'/);
      expect(args).not.toMatch(/m\.email/);
      expect(args).not.toMatch(/status_token/i);
      expect(args).not.toMatch(/poll/i);
      expect(args).not.toMatch(/alice@/i);
    }
  });

  test("synthetic labels and non-RFC emails are not used as fill source", () => {
    expect(body).toMatch(/slack_%/);
    expect(body).toMatch(/org_owner/);
    expect(body).toMatch(/approval_delivery_alert/);
    expect(body).toMatch(/audit_pr6_is_rfc_email/);
  });

  test("apply / rollback org lists default empty (0 updates)", () => {
    expect(apply).toMatch(/pr6_apply_orgs/);
    expect(apply).toMatch(/delete from pr6_apply_orgs/);
    expect(apply).toMatch(/backfill_audit_actor_email_pr6_batch/i);
    expect(apply).not.toMatch(/insert into pr6_apply_orgs/);
    expect(rollback).toMatch(/pr6_rollback_orgs/);
    expect(rollback).toMatch(/delete from pr6_rollback_orgs/);
    expect(rollback).toMatch(/rollback_audit_actor_email_pr6_batch/i);
    expect(rollback).not.toMatch(/insert into pr6_rollback_orgs/);
  });

  test("rollback clears only the PR-6 mark and nulls actor_email", () => {
    expect(body).toMatch(/metadata->>'backfill' = 'actor_email_pr6'/);
    expect(body).toMatch(/actor_email = null/i);
    expect(body).toMatch(/metadata = coalesce\(a\.metadata, '\{\}'::jsonb\) - 'backfill'/);
    expect(rollback).toMatch(/remaining_marks/);
  });

  test("preflight and verify SELECTs exist and do not write", () => {
    const pre = uncommented(preflight);
    const ver = uncommented(verify);
    expect(pre).toMatch(/fillable/);
    expect(ver).toMatch(/still_fillable/);
    expect(ver).toMatch(/cross_org_marked/);
    expect(pre).not.toMatch(/\bupdate\b/i);
    expect(pre).not.toMatch(/\binsert\b/i);
    expect(ver).not.toMatch(/\bupdate\b/i);
    expect(ver).not.toMatch(/\binsert\b/i);
    expect(preflight.toLowerCase()).not.toMatch(/md5|digest|sha256|status_token|poll_path/);
  });

  test("helpers are revoked from PUBLIC / anon / authenticated", () => {
    expect(body).toMatch(/revoke all on function public\.backfill_audit_actor_email_pr6_batch/i);
    expect(body).toMatch(/revoke all on function public\.rollback_audit_actor_email_pr6_batch/i);
    expect(body).toMatch(/from public, anon, authenticated/i);
    expect(body).toMatch(/grant execute[\s\S]*to service_role/i);
  });
});
