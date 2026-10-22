/**
 * PR-1: every admin.* row has a displayable who when
 * ADMIN_AUDIT_WHO_REQUIRED_ENABLED applies to the org.
 * Flag OFF keeps today's human | admin_agent contract (empty email allowed).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { getRuntimeAudit } from "@/lib/demo-data";
import {
  isAdminAuditWhoRequiredEnabled,
  isAdminAuditWhoRequiredEnabledForOrg,
} from "@/lib/feature-flags";

const FLAG = "ADMIN_AUDIT_WHO_REQUIRED_ENABLED";
const ORGS = "ADMIN_AUDIT_WHO_REQUIRED_ORG_IDS";
const saved: { flag?: string; orgs?: string } = {};

beforeEach(() => {
  saved.flag = process.env[FLAG];
  saved.orgs = process.env[ORGS];
  delete process.env[FLAG];
  delete process.env[ORGS];
});

afterEach(() => {
  if (saved.flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved.flag;
  if (saved.orgs === undefined) delete process.env[ORGS];
  else process.env[ORGS] = saved.orgs;
});

describe("ADMIN_AUDIT_WHO_REQUIRED flag", () => {
  test("defaults OFF and missing orgId stays OFF", () => {
    expect(isAdminAuditWhoRequiredEnabled()).toBe(false);
    expect(isAdminAuditWhoRequiredEnabledForOrg(DEMO_ORG.id)).toBe(false);
    expect(isAdminAuditWhoRequiredEnabledForOrg(null)).toBe(false);
    expect(isAdminAuditWhoRequiredEnabledForOrg("")).toBe(false);
    expect(isAdminAuditWhoRequiredEnabledForOrg(undefined)).toBe(false);
  });

  test("ON + empty org list applies to every org; missing orgId stays OFF", () => {
    process.env[FLAG] = "true";
    expect(isAdminAuditWhoRequiredEnabled()).toBe(true);
    expect(isAdminAuditWhoRequiredEnabledForOrg(DEMO_ORG.id)).toBe(true);
    expect(isAdminAuditWhoRequiredEnabledForOrg("org_other")).toBe(true);
    expect(isAdminAuditWhoRequiredEnabledForOrg(null)).toBe(false);
  });

  test("ON + org allowlist is fail-closed to listed orgs only", () => {
    process.env[FLAG] = "true";
    process.env[ORGS] = `${DEMO_ORG.id}, org_pilot`;
    expect(isAdminAuditWhoRequiredEnabledForOrg(DEMO_ORG.id)).toBe(true);
    expect(isAdminAuditWhoRequiredEnabledForOrg("org_pilot")).toBe(true);
    expect(isAdminAuditWhoRequiredEnabledForOrg("org_other")).toBe(false);
  });
});

describe("admin audit who contract", () => {
  test("flag OFF: admin_agent without email still writes (regression)", async () => {
    const { appendAdminAuditEvent, adminAgentAuditActor, assertAdminAuditIdentity } =
      await import("@/lib/audit/admin-audit");
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.policy",
        metadata: { actorKind: "admin_agent", adminAgentId: "adm_1", generation: 1 },
      })
    ).not.toThrow();
    const before = getRuntimeAudit().length;
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: "flag off admin_agent",
      actor: adminAgentAuditActor("adm_1", 1),
    });
    const row = getRuntimeAudit()[0];
    expect(getRuntimeAudit().length).toBeGreaterThan(before);
    expect(row.metadata?.actorKind).toBe("admin_agent");
    expect(row.actorEmail ?? null).toBeNull();
    expect(row.metadata?.actorLabel).toBeUndefined();
  });

  test("flag ON: admin_agent writes as system + actorLabel and never fabricates email", async () => {
    process.env[FLAG] = "true";
    const { appendAdminAuditEvent, adminAgentAuditActor, systemAdminActor, assertAdminAuditIdentity } =
      await import("@/lib/audit/admin-audit");
    const label = systemAdminActor("管理MCP");
    expect(label).toEqual({ actorKind: "system", actorLabel: "管理MCP" });
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.policy",
        orgId: DEMO_ORG.id,
        metadata: { actorKind: "admin_agent", adminAgentId: "adm_1", generation: 1 },
      })
    ).toThrow(/actorKind|actorLabel|who/i);

    const before = getRuntimeAudit().length;
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: "flag on admin_agent",
      actor: adminAgentAuditActor("adm_1", 1),
    });
    const row = getRuntimeAudit()[0];
    expect(getRuntimeAudit().length).toBeGreaterThan(before);
    expect(row.metadata?.actorKind).toBe("system");
    expect(typeof row.metadata?.actorLabel).toBe("string");
    expect(String(row.metadata?.actorLabel).trim().length).toBeGreaterThan(0);
    expect(row.actorEmail ?? null).toBeNull();
    expect(JSON.stringify(row.metadata)).not.toMatch(/@/);
  });

  test("flag ON: system actor requires a non-email label and refuses secrets", async () => {
    process.env[FLAG] = "true";
    const { systemAdminActor, assertAdminAuditIdentity } = await import("@/lib/audit/admin-audit");
    expect(() => systemAdminActor("")).toThrow(/actorLabel/i);
    expect(() => systemAdminActor("ops@example.com")).toThrow(/email|actorLabel/i);
    expect(() => systemAdminActor("gb_adm_deadbeefdeadbeef")).toThrow(/secret|actorLabel/i);
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.ingressHandoff",
        orgId: DEMO_ORG.id,
        metadata: { actorKind: "system" },
      })
    ).toThrow(/actorLabel/i);
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.ingressHandoff",
        orgId: DEMO_ORG.id,
        actorEmail: "system@example.com",
        metadata: { actorKind: "system", actorLabel: "ingress" },
      })
    ).toThrow(/system.*email|email.*forbidden|actorEmail/i);
  });

  test("flag ON: real approver email is kept, never replaced with a fake address", async () => {
    process.env[FLAG] = "true";
    const { appendAdminAuditEvent, adminActorFromApproval } = await import("@/lib/audit/admin-audit");
    const actor = adminActorFromApproval({
      resolvedBy: "web:approver@example.com",
      metadata: {
        adminRequester: {
          kind: "admin_agent",
          actorId: "adm_req",
          grokBotAgentId: "grok_req",
          credentialGeneration: 4,
        },
      },
    });
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: "approved with who",
      actor,
    });
    const row = getRuntimeAudit()[0];
    expect(row.actorEmail).toBe("approver@example.com");
    expect(row.metadata?.actorKind).toBe("human");
    expect(row.metadata?.actorLabel).toBeUndefined();
  });

  test("flag ON: other org in allowlist is not enforced (tenant isolation)", async () => {
    process.env[FLAG] = "true";
    process.env[ORGS] = "org_pilot_only";
    const { appendAdminAuditEvent, adminAgentAuditActor } = await import("@/lib/audit/admin-audit");
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: "other org not gated",
      actor: adminAgentAuditActor("adm_1", 1),
    });
    const row = getRuntimeAudit()[0];
    expect(row.metadata?.actorKind).toBe("admin_agent");
    expect(row.actorEmail ?? null).toBeNull();
  });
});
