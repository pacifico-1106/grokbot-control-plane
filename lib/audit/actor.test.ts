import { describe, expect, test } from "bun:test";
import type { AuditEvent } from "@/lib/types";
import { resolveAuditActor } from "./actor";

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
