import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuditEvent } from "@/lib/types";
import { resolveAuditActor } from "./actor";

const PAGE_WHO = "AUDIT_PAGE_ADMIN_WHO_ENABLED";
const PAGE_WHO_ORGS = "AUDIT_PAGE_ADMIN_WHO_ORG_IDS";

const base = {
  id: "a",
  orgId: "org_a",
  credentialId: null,
  purpose: null,
  createdAt: "2026-10-16T00:00:00.000Z",
} as const;

describe("resolveAuditActor", () => {
  test("employee_id is AI; never uses approval_notify_email", () => {
    const event = {
      ...base,
      employeeId: "emp_1",
      action: "tool.invoke",
      summary: "x",
      metadata: {},
      actorEmail: "human@example.com",
    } as AuditEvent;
    const view = resolveAuditActor(event, {
      employeesById: new Map([["emp_1", { displayName: "営業AI社員" }]]),
      mailboxEmailByEmployeeId: new Map([["emp_1", "bot@sample.example"]]),
    });
    expect(view.kind).toBe("ai");
    expect(view.name).toBe("営業AI社員");
    expect(view.emailMasked).toBe("b***@sample.example");
    expect(JSON.stringify(view)).not.toContain("human@example.com");
  });

  test("slack actor key is human without leaking the raw id as email", () => {
    const view = resolveAuditActor({
      ...base,
      employeeId: null,
      actorEmail: "slack:U0123ABCD",
      action: "approval.resolved",
      summary: "承認",
      metadata: {},
    } as AuditEvent);
    expect(view.kind).toBe("human");
    expect(view.name).toBe("Slack 承認者");
    expect(view.emailMasked).toBeNull();
    expect(JSON.stringify(view)).not.toContain("U0123ABCD");
  });

  test("old row with neither employee nor email is システム and does not throw", () => {
    const view = resolveAuditActor({
      ...base,
      employeeId: null,
      action: "billing.updated",
      summary: "請求",
      metadata: {},
    } as AuditEvent);
    expect(view).toEqual({ kind: "system", name: "システム", emailMasked: null, employeeId: null });
  });
});

describe("resolveAuditActor: emergency-stop trail uses started_by, not employee_id", () => {
  const purchasing = {
    employeesById: new Map([["emp_buy", { displayName: "購買AI社員" }]]),
    membersByEmail: new Map([
      ["owner@example.com", { displayName: "山田 太郎", email: "owner@example.com" }],
    ]),
    membersById: new Map([
      ["mem_1", { displayName: "山田 太郎", email: "owner@example.com" }],
    ]),
  };

  function holdEvent(partial: Partial<AuditEvent> & Pick<AuditEvent, "action">): AuditEvent {
    return {
      ...base,
      employeeId: "emp_buy",
      actorEmail: null,
      summary: "緊急停止",
      metadata: {},
      ...partial,
    } as AuditEvent;
  }

  test("human-started employee stop is 人, never AI・購買AI社員", () => {
    const view = resolveAuditActor(
      holdEvent({
        action: "employee.hold.started",
        actorEmail: "owner@example.com",
        metadata: { startedBy: "member:mem_1" },
      }),
      purchasing
    );
    expect(view.kind).toBe("human");
    expect(view.name).toBe("山田 太郎");
    expect(view.emailMasked).toBe("o***@example.com");
    expect(view.employeeId).toBeNull();
    expect(JSON.stringify(view)).not.toContain("購買AI社員");
    expect(JSON.stringify(view)).not.toContain("emp_buy");
  });

  test("released employee stop is the releaser (releasedBy), not the held AI", () => {
    const view = resolveAuditActor(
      holdEvent({
        action: "employee.hold.released",
        actorEmail: "owner@example.com",
        metadata: { releasedBy: "member:mem_1", requestedBy: "member:mem_2" },
      }),
      purchasing
    );
    expect(view.kind).toBe("human");
    expect(view.name).toBe("山田 太郎");
    expect(JSON.stringify(view)).not.toContain("購買AI社員");
  });

  test("metadata.actorEmail cannot forge the stop actor when started_by is a member", () => {
    const view = resolveAuditActor(
      holdEvent({
        action: "employee.hold.started",
        actorEmail: "owner@example.com",
        metadata: { startedBy: "member:mem_1", actorEmail: "forged@evil.invalid" },
      }),
      purchasing
    );
    expect(view.kind).toBe("human");
    expect(view.emailMasked).toBe("o***@example.com");
    expect(JSON.stringify(view)).not.toContain("forged@evil.invalid");
    expect(JSON.stringify(view)).not.toContain("evil");
  });

  test("started_by missing → 不明, not AI from employee_id", () => {
    const view = resolveAuditActor(holdEvent({ action: "employee.hold.started" }), purchasing);
    expect(view.kind).toBe("unknown");
    expect(view.name).toBe("不明");
    expect(view.employeeId).toBeNull();
    expect(JSON.stringify(view)).not.toContain("購買AI社員");
  });

  test("started_by ambiguous → 不明, not AI and not システム", () => {
    for (const startedBy of ["someone", "ai:agent", "employee:emp_buy", "member:", "ops:", "system:other", ""]) {
      const view = resolveAuditActor(
        holdEvent({ action: "employee.hold.started", metadata: { startedBy } }),
        purchasing
      );
      expect(view.kind).toBe("unknown");
      expect(view.name).toBe("不明");
      expect(JSON.stringify(view)).not.toContain("購買AI社員");
    }
  });

  test("system:anomaly stop is システム, not the held employee", () => {
    const view = resolveAuditActor(
      holdEvent({
        action: "employee.hold.started",
        metadata: { startedBy: "system:anomaly" },
      }),
      purchasing
    );
    expect(view).toEqual({ kind: "system", name: "システム", emailMasked: null, employeeId: null });
  });

  test("self_approval_denied is the denying member, not the held AI", () => {
    const view = resolveAuditActor(
      holdEvent({
        action: "employee.hold.self_approval_denied",
        actorEmail: "admin@example.com",
        metadata: { actor: "member:mem_2", memberId: "mem_2", holdId: "hold_1", reason: "self_approval_denied" },
      }),
      purchasing
    );
    expect(view.kind).toBe("human");
    expect(view.employeeId).toBeNull();
    expect(JSON.stringify(view)).not.toContain("購買AI社員");
    expect(JSON.stringify(view)).not.toContain("emp_buy");
  });

  test("ops-console stop is 人 (運営), not the held employee", () => {
    const view = resolveAuditActor(
      holdEvent({
        action: "employee.hold.started",
        actorEmail: "ops@staffpass.example",
        metadata: { startedBy: "ops:ops@staffpass.example" },
      }),
      purchasing
    );
    expect(view.kind).toBe("human");
    expect(view.name).toBe("運営");
    expect(view.emailMasked).toBe("o***@staffpass.example");
    expect(JSON.stringify(view)).not.toContain("購買AI社員");
  });
});

describe("AUDIT_PAGE_ADMIN_WHO: admin.* prefer actor_email / actorKind", () => {
  const envBackup: Record<string, string | undefined> = {};
  const lookups = {
    employeesById: new Map([["emp_sales", { displayName: "営業AI社員" }]]),
    membersByEmail: new Map([
      ["reviewer@example.com", { displayName: "佐藤 花子", email: "reviewer@example.com" }],
    ]),
  };

  function policyEvent(partial: Partial<AuditEvent> = {}): AuditEvent {
    return {
      ...base,
      employeeId: "emp_sales",
      action: "admin.policy",
      summary: "営業AI社員 の権限を人確認のうえで更新",
      actorEmail: "reviewer@example.com",
      metadata: { actorKind: "human", tool: "policy.patch" },
      ...partial,
    } as AuditEvent;
  }

  beforeEach(() => {
    envBackup[PAGE_WHO] = process.env[PAGE_WHO];
    envBackup[PAGE_WHO_ORGS] = process.env[PAGE_WHO_ORGS];
    delete process.env[PAGE_WHO];
    delete process.env[PAGE_WHO_ORGS];
  });

  afterEach(() => {
    for (const key of [PAGE_WHO, PAGE_WHO_ORGS]) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
  });

  test("flag defaults OFF; missing orgId stays OFF", async () => {
    const { isAuditPageAdminWhoEnabled, isAuditPageAdminWhoEnabledForOrg } = await import(
      "@/lib/feature-flags"
    );
    expect(isAuditPageAdminWhoEnabled()).toBe(false);
    expect(isAuditPageAdminWhoEnabledForOrg("org_a")).toBe(false);
    expect(isAuditPageAdminWhoEnabledForOrg(null)).toBe(false);
    expect(isAuditPageAdminWhoEnabledForOrg("")).toBe(false);
  });

  test("flag OFF: policy.patch with employee_id is still AI (today)", () => {
    const view = resolveAuditActor(policyEvent(), lookups);
    expect(view.kind).toBe("ai");
    expect(view.name).toBe("営業AI社員");
    expect(JSON.stringify(view)).not.toContain("佐藤 花子");
  });

  test("flag ON: policy.patch shows the human approver, not the target AI", () => {
    process.env[PAGE_WHO] = "true";
    const view = resolveAuditActor(policyEvent(), lookups);
    expect(view.kind).toBe("human");
    expect(view.name).toBe("佐藤 花子");
    expect(view.emailMasked).toBe("r***@example.com");
    expect(view.employeeId).toBeNull();
    expect(JSON.stringify(view)).not.toContain("営業AI社員");
    expect(JSON.stringify(view)).not.toContain("emp_sales");
  });

  test("flag ON: system / placeholder actorKind is システム, not AI", () => {
    process.env[PAGE_WHO] = "true";
    const system = resolveAuditActor(
      policyEvent({
        actorEmail: null,
        metadata: { actorKind: "system", actorLabel: "管理MCP" },
      }),
      lookups
    );
    expect(system).toEqual({ kind: "system", name: "システム", emailMasked: null, employeeId: null });

    const placeholder = resolveAuditActor(
      policyEvent({
        actorEmail: null,
        metadata: { actorKind: "admin_agent", adminAgentId: "adm_1", generation: 1 },
      }),
      lookups
    );
    expect(placeholder).toEqual({ kind: "system", name: "システム", emailMasked: null, employeeId: null });
  });

  test("flag ON: admin_agent + approver email still shows the human", () => {
    process.env[PAGE_WHO] = "true";
    const view = resolveAuditActor(
      policyEvent({
        metadata: { actorKind: "admin_agent", adminAgentId: "adm_1", generation: 1 },
      }),
      lookups
    );
    expect(view.kind).toBe("human");
    expect(view.name).toBe("佐藤 花子");
  });

  test("flag ON + org allowlist: other org stays today's AI", () => {
    process.env[PAGE_WHO] = "true";
    process.env[PAGE_WHO_ORGS] = "org_pilot_only";
    const view = resolveAuditActor(policyEvent(), lookups);
    expect(view.kind).toBe("ai");
    expect(view.name).toBe("営業AI社員");
  });

  test("flag ON: non-admin.* with employee_id stays AI", () => {
    process.env[PAGE_WHO] = "true";
    const view = resolveAuditActor(
      {
        ...base,
        employeeId: "emp_sales",
        action: "tool.invoke",
        summary: "x",
        metadata: { actorKind: "human" },
        actorEmail: "reviewer@example.com",
      } as AuditEvent,
      lookups
    );
    expect(view.kind).toBe("ai");
    expect(view.name).toBe("営業AI社員");
  });

  test("flag ON: hold trail has no regression", () => {
    process.env[PAGE_WHO] = "true";
    const view = resolveAuditActor(
      {
        ...base,
        employeeId: "emp_sales",
        actorEmail: "owner@example.com",
        action: "employee.hold.started",
        summary: "緊急停止",
        metadata: { startedBy: "member:mem_1" },
      } as AuditEvent,
      {
        employeesById: new Map([["emp_sales", { displayName: "営業AI社員" }]]),
        membersByEmail: new Map([
          ["owner@example.com", { displayName: "山田 太郎", email: "owner@example.com" }],
        ]),
        membersById: new Map([["mem_1", { displayName: "山田 太郎", email: "owner@example.com" }]]),
      }
    );
    expect(view.kind).toBe("human");
    expect(view.name).toBe("山田 太郎");
    expect(view.employeeId).toBeNull();
    expect(JSON.stringify(view)).not.toContain("営業AI社員");
  });
});
