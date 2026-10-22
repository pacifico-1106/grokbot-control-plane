/**
 * PR-2: approvalRoutes.patch / decision.deputy* / credential.renew_*
 * become admin.* events when the six-field flag is ON. Flag OFF keeps
 * today's action names.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { recordCredentialAutoRenewFiling } from "@/lib/employees/credential-auto-renew";
import {
  demoResetCredentialRenewals,
} from "@/lib/data/credential-renewals";

const FLAG = "ADMIN_AUDIT_SIX_FIELD_WRITE_ENABLED";
const ORGS = "ADMIN_AUDIT_SIX_FIELD_WRITE_ORG_IDS";
const saved: { flag?: string; orgs?: string } = {};

beforeEach(() => {
  saved.flag = process.env[FLAG];
  saved.orgs = process.env[ORGS];
  delete process.env[FLAG];
  delete process.env[ORGS];
  demoResetCredentialRenewals();
});

afterEach(() => {
  if (saved.flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved.flag;
  if (saved.orgs === undefined) delete process.env[ORGS];
  else process.env[ORGS] = saved.orgs;
  demoResetCredentialRenewals();
});

describe("admin.* class events (six-field)", () => {
  test("flag OFF: credential.renew_proposed keeps the legacy action (regression)", async () => {
    const emp = getRuntimeEmployees().find((e) => e.orgId === DEMO_ORG.id);
    expect(emp).toBeTruthy();
    const recorded = await recordCredentialAutoRenewFiling({
      orgId: DEMO_ORG.id,
      employeeId: emp!.id,
      oldCredentialId: emp!.credentialId || "cred_six_off",
      approvalId: "apr_renew_off",
      source: "admin_mcp",
    });
    expect(recorded.ok).toBe(true);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === "apr_renew_off");
    expect(row).toBeTruthy();
    expect(row!.action).toBe("credential.renew_proposed");
    expect(row!.metadata?.target).toBeUndefined();
    expect(row!.metadata?.result).toBeUndefined();
  });

  test("flag ON: credential.renew_proposed is written as admin.credential.renew_proposed with six fields", async () => {
    process.env[FLAG] = "true";
    const emp = getRuntimeEmployees().find((e) => e.orgId === DEMO_ORG.id);
    expect(emp).toBeTruthy();
    const recorded = await recordCredentialAutoRenewFiling({
      orgId: DEMO_ORG.id,
      employeeId: emp!.id,
      oldCredentialId: emp!.credentialId || "cred_six_on",
      approvalId: "apr_renew_on",
      source: "admin_mcp",
    });
    expect(recorded.ok).toBe(true);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === "apr_renew_on");
    expect(row).toBeTruthy();
    expect(row!.action).toBe("admin.credential.renew_proposed");
    expect(row!.metadata?.target).toEqual({ type: "employee", id: emp!.id });
    const reason = row!.metadata?.reason as { code?: string; labelJa?: string };
    expect(reason.code).toBeTruthy();
    expect(reason.labelJa).toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
    expect(row!.metadata?.result).toBe("pending");
    expect(JSON.stringify(row!.metadata)).not.toMatch(/gb_emp_|claim_token|oneTimeSecret/);
  });

  test("flag ON: helper maps approvalRoutes / deputy / renew aliases to admin.*", async () => {
    process.env[FLAG] = "true";
    const { adminSixFieldAction } = await import("@/lib/audit/admin-audit");
    expect(adminSixFieldAction(DEMO_ORG.id, "approval_routes.patch", "admin.approvalRoutes.patch")).toBe(
      "admin.approvalRoutes.patch"
    );
    expect(adminSixFieldAction(DEMO_ORG.id, "decision.deputy_activated", "admin.decision.deputy_activated")).toBe(
      "admin.decision.deputy_activated"
    );
    expect(adminSixFieldAction(DEMO_ORG.id, "decision.deputy_activated", "admin.decision.deputyActivate")).toBe(
      "admin.decision.deputyActivate"
    );
    expect(adminSixFieldAction(DEMO_ORG.id, "credential.renew_approved", "admin.credential.renew_approved")).toBe(
      "admin.credential.renew_approved"
    );
  });

  test("flag OFF: helper keeps legacy action names", async () => {
    const { adminSixFieldAction } = await import("@/lib/audit/admin-audit");
    expect(adminSixFieldAction(DEMO_ORG.id, "approval_routes.patch", "admin.approvalRoutes.patch")).toBe(
      "approval_routes.patch"
    );
    expect(adminSixFieldAction(DEMO_ORG.id, "credential.renew_proposed", "admin.credential.renew_proposed")).toBe(
      "credential.renew_proposed"
    );
  });
});
