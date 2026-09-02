import { describe, expect, test } from "bun:test";
import {
  filterAdminChangeLogEvents,
  isAdminAuditAction,
  isOperationalAuditAction,
  auditActionForAdminTool,
} from "@/lib/admin-mcp/audit-class";
import { leadChangeLogEvents } from "@/lib/dashboard/change-log";

describe("admin audit class is separate", () => {
  test("hire / policy / parties are admin class", () => {
    expect(isAdminAuditAction("admin.hire")).toBe(true);
    expect(isAdminAuditAction("admin.policy")).toBe(true);
    expect(isAdminAuditAction("admin.parties")).toBe(true);
    expect(isAdminAuditAction("admin.channel")).toBe(true);
    expect(auditActionForAdminTool("employees.issue")).toBe("admin.hire");
    expect(auditActionForAdminTool("parties.upsert")).toBe("admin.parties");
  });

  test("tool.invoke / mail.send / comm.reply are not the change-log class", () => {
    expect(isAdminAuditAction("tool.invoke")).toBe(false);
    expect(isOperationalAuditAction("tool.invoke")).toBe(true);
    expect(isOperationalAuditAction("mail.send")).toBe(true);
    expect(isOperationalAuditAction("comm.reply")).toBe(true);
  });

  test("change log lead list drops operational events", () => {
    const events = [
      { action: "admin.hire", createdAt: "2026-09-01T00:00:00Z" },
      { action: "tool.invoke", createdAt: "2026-09-01T00:01:00Z" },
      { action: "mail.send", createdAt: "2026-09-01T00:02:00Z" },
      { action: "admin.parties", createdAt: "2026-09-01T00:03:00Z" },
    ];
    expect(filterAdminChangeLogEvents(events).map((e) => e.action)).toEqual([
      "admin.hire",
      "admin.parties",
    ]);
    expect(leadChangeLogEvents(events).map((e) => e.action)).toEqual([
      "admin.hire",
      "admin.parties",
    ]);
  });
});
