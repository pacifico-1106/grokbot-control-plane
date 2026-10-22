/**
 * PR-2: six-field write contract (who / when / target / action / reason / result)
 * on appendAdminAuditEvent when ADMIN_AUDIT_SIX_FIELD_WRITE_ENABLED applies.
 * Flag OFF keeps today's metadata (no target / structured reason / result).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import {
  isAdminAuditSixFieldWriteEnabled,
  isAdminAuditSixFieldWriteEnabledForOrg,
} from "@/lib/feature-flags";

const FLAG = "ADMIN_AUDIT_SIX_FIELD_WRITE_ENABLED";
const ORGS = "ADMIN_AUDIT_SIX_FIELD_WRITE_ORG_IDS";
const WHO = "ADMIN_AUDIT_WHO_REQUIRED_ENABLED";
const saved: { flag?: string; orgs?: string; who?: string } = {};

beforeEach(() => {
  saved.flag = process.env[FLAG];
  saved.orgs = process.env[ORGS];
  saved.who = process.env[WHO];
  delete process.env[FLAG];
  delete process.env[ORGS];
  delete process.env[WHO];
});

afterEach(() => {
  if (saved.flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved.flag;
  if (saved.orgs === undefined) delete process.env[ORGS];
  else process.env[ORGS] = saved.orgs;
  if (saved.who === undefined) delete process.env[WHO];
  else process.env[WHO] = saved.who;
});

function latestPolicy() {
  return getRuntimeAudit().find((e) => e.orgId === DEMO_ORG.id && e.action === "admin.policy");
}

describe("ADMIN_AUDIT_SIX_FIELD_WRITE flag", () => {
  test("defaults OFF and missing orgId stays OFF", () => {
    expect(isAdminAuditSixFieldWriteEnabled()).toBe(false);
    expect(isAdminAuditSixFieldWriteEnabledForOrg(DEMO_ORG.id)).toBe(false);
    expect(isAdminAuditSixFieldWriteEnabledForOrg(null)).toBe(false);
    expect(isAdminAuditSixFieldWriteEnabledForOrg("")).toBe(false);
    expect(isAdminAuditSixFieldWriteEnabledForOrg(undefined)).toBe(false);
  });

  test("ON + empty org list applies to every org; missing orgId stays OFF", () => {
    process.env[FLAG] = "true";
    expect(isAdminAuditSixFieldWriteEnabled()).toBe(true);
    expect(isAdminAuditSixFieldWriteEnabledForOrg(DEMO_ORG.id)).toBe(true);
    expect(isAdminAuditSixFieldWriteEnabledForOrg("org_other")).toBe(true);
    expect(isAdminAuditSixFieldWriteEnabledForOrg(null)).toBe(false);
  });

  test("ON + org allowlist is fail-closed to listed orgs only", () => {
    process.env[FLAG] = "true";
    process.env[ORGS] = `${DEMO_ORG.id}, org_pilot`;
    expect(isAdminAuditSixFieldWriteEnabledForOrg(DEMO_ORG.id)).toBe(true);
    expect(isAdminAuditSixFieldWriteEnabledForOrg("org_pilot")).toBe(true);
    expect(isAdminAuditSixFieldWriteEnabledForOrg("org_other")).toBe(false);
  });
});

describe("six-field write contract", () => {
  test("flag OFF: metadata has no target / structured reason / result (regression)", async () => {
    const { appendAdminAuditEvent, humanAdminActor } = await import("@/lib/audit/admin-audit");
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: "flag off six field",
      actor: humanAdminActor("owner@example.com"),
      metadata: { approvalId: "apr_off" },
    });
    const row = latestPolicy();
    expect(row).toBeTruthy();
    expect(row!.metadata?.target).toBeUndefined();
    expect(row!.metadata?.result).toBeUndefined();
    expect(row!.metadata?.reason).toBeUndefined();
    expect(row!.action).toBe("admin.policy");
    expect(row!.createdAt).toBeTruthy();
    expect(row!.actorEmail).toBe("owner@example.com");
  });

  test("flag ON success: who / when / target / action / reason / result", async () => {
    process.env[FLAG] = "true";
    const { appendAdminAuditEvent, humanAdminActor } = await import("@/lib/audit/admin-audit");
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_six",
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: "six field success",
      actor: humanAdminActor("owner@example.com"),
      target: { type: "employee", id: "emp_six" },
      reason: { code: "approved", labelJa: "承認されて実行しました" },
      result: "success",
    });
    const row = latestPolicy();
    expect(row).toBeTruthy();
    expect(row!.actorEmail).toBe("owner@example.com");
    expect(row!.createdAt).toBeTruthy();
    expect(row!.action).toBe("admin.policy");
    expect(row!.metadata?.target).toEqual({ type: "employee", id: "emp_six" });
    expect(row!.metadata?.reason).toEqual({ code: "approved", labelJa: "承認されて実行しました" });
    expect(row!.metadata?.result).toBe("success");
  });

  test("flag ON denial: result=denied and reason is a short code + Japanese label", async () => {
    process.env[FLAG] = "true";
    const { appendAdminAuditEvent, humanAdminActor } = await import("@/lib/audit/admin-audit");
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "approver_authority.web_denied",
      summary: "承認者・権限の直接変更を拒否",
      actor: humanAdminActor("owner@example.com"),
      target: { type: "org", id: DEMO_ORG.id },
      reason: { code: "approver_not_authorized", labelJa: "この操作を承認できる人ではありません" },
      result: "denied",
    });
    const row = latestPolicy();
    expect(row!.metadata?.result).toBe("denied");
    const reason = row!.metadata?.reason as { code?: string; labelJa?: string };
    expect(reason.code).toBe("approver_not_authorized");
    expect(reason.labelJa).toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
    expect(reason.labelJa).not.toMatch(/@|gb_adm_|gb_emp_|secret/i);
  });

  test("flag ON: derives six fields when the caller omits them", async () => {
    process.env[FLAG] = "true";
    const { appendAdminAuditEvent, humanAdminActor } = await import("@/lib/audit/admin-audit");
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: "承認待ち: 権限を更新",
      actor: humanAdminActor("owner@example.com"),
      metadata: { approvalId: "apr_derive", code: "needs_approval" },
    });
    const row = latestPolicy();
    expect(row!.metadata?.target).toEqual({ type: "approval", id: "apr_derive" });
    expect((row!.metadata?.reason as { code?: string }).code).toBe("needs_approval");
    expect((row!.metadata?.reason as { labelJa?: string }).labelJa).toMatch(/承認/);
    expect(row!.metadata?.result).toBe("pending");
  });

  test("flag ON: refuses secrets and PII in reason", async () => {
    process.env[FLAG] = "true";
    const { appendAdminAuditEvent, humanAdminActor } = await import("@/lib/audit/admin-audit");
    await expect(
      appendAdminAuditEvent({
        orgId: DEMO_ORG.id,
        employeeId: null,
        credentialId: null,
        action: "admin.policy",
        purpose: "admin.policy",
        summary: "secret reason",
        actor: humanAdminActor("owner@example.com"),
        target: { type: "org", id: DEMO_ORG.id },
        reason: { code: "approved", labelJa: "token gb_adm_deadbeefdeadbeef" },
        result: "success",
      })
    ).rejects.toThrow(/secret|reason/i);
    await expect(
      appendAdminAuditEvent({
        orgId: DEMO_ORG.id,
        employeeId: null,
        credentialId: null,
        action: "admin.policy",
        purpose: "admin.policy",
        summary: "pii reason",
        actor: humanAdminActor("owner@example.com"),
        target: { type: "org", id: DEMO_ORG.id },
        reason: { code: "approved", labelJa: "owner@example.com が承認" },
        result: "success",
      })
    ).rejects.toThrow(/reason|email|pii/i);
  });

  test("flag ON: does not persist full rule text; hash/summary only", async () => {
    process.env[FLAG] = "true";
    const { appendAdminAuditEvent, humanAdminActor } = await import("@/lib/audit/admin-audit");
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: "社内判定ルールを更新",
      actor: humanAdminActor("owner@example.com"),
      target: { type: "org_internal_audience_rule", id: DEMO_ORG.id },
      reason: { code: "approved", labelJa: "承認されて実行しました" },
      result: "success",
      metadata: {
        rule: {
          emailDomains: ["secret-internal.example"],
          slackTeamIds: ["TSECRETTEAM"],
          autoSlackTeamInternal: true,
        },
      },
    });
    const row = latestPolicy();
    const blob = JSON.stringify(row!.metadata);
    expect(row!.metadata?.rule).toBeUndefined();
    expect(blob).not.toContain("secret-internal.example");
    expect(blob).not.toContain("TSECRETTEAM");
    expect(row!.metadata?.target).toEqual({ type: "org_internal_audience_rule", id: DEMO_ORG.id });
    const hash = row!.metadata?.ruleHashPrefix;
    expect(typeof hash === "string" || row!.metadata?.ruleSummary != null).toBe(true);
    if (typeof hash === "string") expect(hash.length).toBeLessThanOrEqual(12);
  });

  test("L2: WHO flag ON rejects actorKind=system when an email is present", async () => {
    process.env[WHO] = "true";
    const { assertAdminAuditIdentity } = await import("@/lib/audit/admin-audit");
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.ingressHandoff",
        orgId: DEMO_ORG.id,
        actorEmail: "system@example.com",
        metadata: { actorKind: "system", actorLabel: "ingress" },
      })
    ).toThrow(/system.*email|email.*forbidden|actorEmail/i);
  });

  test("flag ON: other org in allowlist is not enforced (tenant isolation)", async () => {
    process.env[FLAG] = "true";
    process.env[ORGS] = "org_pilot_only";
    const { appendAdminAuditEvent, humanAdminActor } = await import("@/lib/audit/admin-audit");
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: "other org not gated",
      actor: humanAdminActor("owner@example.com"),
      target: { type: "org", id: DEMO_ORG.id },
      reason: { code: "approved", labelJa: "承認されて実行しました" },
      result: "success",
    });
    const row = latestPolicy();
    expect(row!.metadata?.target).toBeUndefined();
    expect(row!.metadata?.result).toBeUndefined();
  });
});
