import { describe, expect, test } from "bun:test";
import { createApproval } from "@/lib/data";
import { DEMO_ORG, pushRuntimeAuditEvent } from "@/lib/demo-data";
import { callStaffpassMcpTool, STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import { STAFFPASS_MCP_TOOL_NAMES } from "@/lib/mcp/public";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import { w1ItemId } from "@/lib/stuck-watch/w1-mention-unanswered";
import {
  runEmployeeStuckList,
  runEmployeeStuckRetry,
} from "@/lib/stuck-watch/employee-handlers";

function demoCred(employeeId = "emp_comm"): ResolvedEmployeeCredential {
  return {
    employeeId,
    orgId: DEMO_ORG.id,
    credentialId: `cred_${employeeId}`,
    generation: 1,
    via: "bearer",
    binding: {
      status: "linked",
      employeeId,
      orgId: DEMO_ORG.id,
      credentialGeneration: 1,
      grokBotAgentId: "agent_test",
      grokBotWorkspaceId: null,
      credentialFingerprint: null,
      lastSuccessAt: null,
      lastError: null,
      wakeWebhookUrl: null,
      hasWakeWebhook: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

describe("staffpass_stuck_list / staffpass_stuck_retry Employee MCP", () => {
  test("tool names are in employee catalog and schema", () => {
    for (const name of ["staffpass_stuck_list", "staffpass_stuck_retry"]) {
      expect(STAFFPASS_MCP_TOOL_NAMES).toContain(name);
      expect(STAFFPASS_MCP_TOOLS.some((tool) => tool.name === name)).toBe(true);
    }
  });

  test("staffpass_stuck_list returns only calling employee items", async () => {
    const channelComm = `C_EMP_LIST_${Date.now()}`;
    const channelOps = `C_EMP_LIST_OPS_${Date.now()}`;
    const wakeAt = new Date(Date.now() - 20 * 60_000).toISOString();

    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "wake comm",
      metadata: { reason: "woke", channel: channelComm, ts: "1.1" },
      createdAt: wakeAt,
    });
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_ops",
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "wake ops",
      metadata: { reason: "woke", channel: channelOps, ts: "2.2" },
      createdAt: wakeAt,
    });

    const result = await callStaffpassMcpTool("staffpass_stuck_list", {}, demoCred("emp_comm"));
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as {
      ok: boolean;
      items?: Array<{ employeeId: string; id: string }>;
      summaryJa?: string;
    };
    expect(data.ok).toBe(true);
    expect(data.summaryJa).toContain("emp_comm");
    expect(data.items?.every((item) => item.employeeId === "emp_comm")).toBe(true);
    expect(data.items?.some((item) => item.id === w1ItemId(channelComm, "1.1"))).toBe(true);
    expect(data.items?.some((item) => item.id === w1ItemId(channelOps, "2.2"))).toBe(false);
  });

  test("runEmployeeStuckList scopes by employeeId", async () => {
    const list = await runEmployeeStuckList(DEMO_ORG.id, "emp_comm", {});
    expect(list.ok).toBe(true);
    expect(list.items?.every((item) => item.employeeId === "emp_comm")).toBe(true);
  });

  test("staffpass_stuck_retry denies cross-employee item", async () => {
    const channel = `C_CROSS_${Date.now()}`;
    const itemId = w1ItemId(channel, "9.9");
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_ops",
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "wake cross test",
      metadata: { reason: "woke", channel, ts: "9.9" },
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });

    const result = await callStaffpassMcpTool(
      "staffpass_stuck_retry",
      { itemId },
      demoCred("emp_comm")
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent as { code: string; nextStepJa?: string };
    expect(data.code).toBe("item_not_owned");
    expect(data.nextStepJa).toContain("staffpass_stuck_list");
  });

  test("staffpass_stuck_retry denies expected_gate item", async () => {
    const itemId = w1ItemId("C_EMP_GATE", "777.001");
    const wakeAt = new Date(Date.now() - 20 * 60_000).toISOString();
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "wake employee gate test",
      metadata: {
        reason: "woke",
        channel: "C_EMP_GATE",
        ts: "777.001",
        eventId: "EvEmpGate",
      },
      createdAt: wakeAt,
    });
    await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      title: "employee gate test reply",
      purpose: "comm.internal",
      summary: "pending reply",
      risk: "medium",
      tool: "comm.reply",
      jobId: "job_emp_gate_test",
      metadata: {},
    });

    const retry = await runEmployeeStuckRetry(DEMO_ORG.id, "emp_comm", { itemId });
    expect(retry.ok).toBe(false);
    expect(retry.code).toBe("expected_gate_no_retry");
    expect(retry.nextStepJa).toContain("自動再発火しません");
  });

  test("staffpass_stuck_retry denies config_drift with fix hint", async () => {
    const driftItemId = w1ItemId(`C_EMP_DRIFT_${Date.now()}`, "3.3");
    const channel = driftItemId.split(":")[1] ?? "C_EMP_DRIFT";
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_ops",
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "wake employee drift test",
      metadata: { reason: "woke", channel, ts: "3.3" },
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_ops",
      credentialId: "cred_ops",
      action: "tool.invoke",
      purpose: "comm.internal",
      summary: "comm.reply を拒否",
      metadata: {
        tool: "comm.reply",
        code: "missing_scope",
        jobId: "job_emp_drift",
      },
      createdAt: new Date(Date.now() - 19 * 60_000).toISOString(),
    });

    const retry = await runEmployeeStuckRetry(DEMO_ORG.id, "emp_ops", {
      itemId: driftItemId,
    });
    expect(retry.ok).toBe(false);
    expect(retry.code).toBe("config_drift_notify_fix");
    expect(retry.nextStepJa).toContain("設定");
    expect(retry.nextStepJa).toContain("管理者");
  });

  test("staffpass_stuck_retry missing itemId returns error", async () => {
    const result = await callStaffpassMcpTool(
      "staffpass_stuck_retry",
      {},
      demoCred("emp_comm")
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent as { code: string };
    expect(data.code).toBe("item_id_required");
  });
});
