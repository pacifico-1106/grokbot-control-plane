import { describe, expect, test } from "bun:test";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { STAFFPASS_MCP_TOOL_NAMES } from "@/lib/mcp/public";
import { GATEWAY_TOOL_DEFS } from "@/lib/gateway/tools";
import {
  ADMIN_MCP_AUDIT_LABELS_JA,
  AUDIT_ACTION_LABELS_JA,
  EMPLOYEE_MCP_AUDIT_LABELS_JA,
  GATEWAY_AUDIT_LABELS_JA,
  auditOperationLabelJa,
  unknownOperationLabelJa,
} from "./labels-ja";

describe("audit Japanese labels", () => {
  test("every Gateway tool id has a short audit label", () => {
    for (const id of Object.keys(GATEWAY_TOOL_DEFS)) {
      expect(GATEWAY_AUDIT_LABELS_JA[id as keyof typeof GATEWAY_AUDIT_LABELS_JA]).toBeTruthy();
      expect(auditOperationLabelJa({ action: "tool.invoke", tool: id }).labelJa).not.toMatch(/^その他の操作/);
    }
  });

  test("every Admin MCP tool name has an audit label", () => {
    for (const id of ADMIN_MCP_TOOL_NAMES) {
      expect(ADMIN_MCP_AUDIT_LABELS_JA[id]).toBeTruthy();
      expect(auditOperationLabelJa({ action: "admin.policy", tool: id }).labelJa).not.toMatch(/^その他の操作/);
    }
  });

  test("employee MCP tools including optional ones are labeled", () => {
    const extra = [
      "staffpass_config_change_request",
      "staffpass_sensitive_topics",
      "staffpass_profile",
    ];
    for (const id of [...STAFFPASS_MCP_TOOL_NAMES, ...extra]) {
      expect(EMPLOYEE_MCP_AUDIT_LABELS_JA[id]).toBeTruthy();
    }
  });

  test("AuditAction map covers the typed union (compile-time Record + runtime keys)", () => {
    expect(Object.keys(AUDIT_ACTION_LABELS_JA).length).toBeGreaterThan(80);
    expect(AUDIT_ACTION_LABELS_JA["tool.invoke"]).toBe("操作を実行");
    expect(AUDIT_ACTION_LABELS_JA["secret_detection.blocked"]).toBe("秘密情報の送信を拒否");
  });

  test("tool.invoke uses metadata.tool; unknown ids stay opaque", () => {
    expect(auditOperationLabelJa({ action: "tool.invoke", tool: "comm.reply" })).toEqual({
      id: "comm.reply",
      labelJa: "Slackにメッセージを送信",
    });
    expect(auditOperationLabelJa({ action: "tool.invoke" }).labelJa).toBe("操作を実行");
    expect(auditOperationLabelJa({ action: "brand.new.action", tool: null })).toEqual({
      id: "brand.new.action",
      labelJa: unknownOperationLabelJa("brand.new.action"),
    });
  });

  test("LINE surface overrides slack-shaped comm tools", () => {
    expect(
      auditOperationLabelJa({ action: "tool.invoke", tool: "comm.reply", surface: "line" }).labelJa
    ).toBe("LINEにメッセージを送信");
  });

  test("does not print raw tool.invoke as the chip label when a tool exists", () => {
    const { labelJa, id } = auditOperationLabelJa({ action: "tool.invoke", tool: "mail.send" });
    expect(labelJa).toBe("メールを送信");
    expect(id).toBe("mail.send");
    expect(labelJa).not.toBe("tool.invoke");
  });

  test("does not interpolate emails or tokens into unknown-operation labels", () => {
    const view = auditOperationLabelJa({
      action: "tool.invoke",
      tool: "alice@example.com /api/approvals/status?token=SECRETTOKEN",
    });
    expect(view.id).toBe("unknown");
    expect(view.labelJa).toBe("その他の操作");
    expect(JSON.stringify(view)).not.toContain("alice@example.com");
    expect(JSON.stringify(view)).not.toContain("SECRETTOKEN");
  });
});
