import { describe, expect, test } from "bun:test";
import { createApproval } from "@/lib/data";
import { DEMO_ORG, pushRuntimeAuditEvent } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import {
  runStuckWatchClassify,
  runStuckWatchResolve,
  runStuckWatchRetry,
} from "@/lib/stuck-watch/admin-handlers";
import { w1ItemId } from "@/lib/stuck-watch/w1-mention-unanswered";
import {
  evaluateW2Eligibility,
  isApprovedUnfulfilled,
} from "@/lib/stuck-watch/w2-unfulfilled";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import type { ApprovalRequest } from "@/lib/types";

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({
    grokBotAgentId: "grok_admin_demo",
    status: "linked",
  });
  return {
    orgId: DEMO_ORG.id,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

function makeW2Approval(): ApprovalRequest {
  const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString();
  return {
    id: "apr_admin_w2",
    orgId: DEMO_ORG.id,
    employeeId: "emp_comm",
    credentialId: "cred_comm",
    title: "test",
    purpose: "comm.reply",
    summary: "summary",
    risk: "medium",
    status: "approved",
    tool: "comm.reply",
    jobId: "job_admin_w2",
    createdAt: sixMinutesAgo,
    resolvedAt: sixMinutesAgo,
    resolvedBy: "owner@example.com",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    telegramRef: null, telegramMessageId: null, statusToken: "fixture",
    pollPath: "/x",
    metadata: {
      invoke: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: "job_admin_w2",
        employeeId: "emp_comm",
        orgId: DEMO_ORG.id,
        postingAs: "bot",
        conversation: { slackChannelId: "C_ADMIN" },
        args: { text: "hello" },
      },
      stuckWatch: {
        w2: { firstDetectedAt: sixMinutesAgo, retryCount: 0 },
      },
    },
  };
}

describe("stuckWatch Admin MCP tools", () => {
  test("stuckWatch.list returns ok with summaryJa", async () => {
    const result = await callAdminMcpTool("stuckWatch.list", {}, demoCred());
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.summaryJa).toBeDefined();
    expect(data.nextStepJa).toBeDefined();
    expect(Array.isArray(data.items)).toBe(true);
  });

  test("stuckWatch.classify by code returns expected_gate for needs_approval", async () => {
    const result = await callAdminMcpTool(
      "stuckWatch.classify",
      { code: "needs_approval" },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const classified = data.classified as { faultClass: string; stuckHint: string };
    expect(classified.faultClass).toBe("expected_gate");
    expect(classified.stuckHint).toBe("wait_approval");
    expect(data.summaryJa).toBeDefined();
    expect(data.nextStepJa).toBeDefined();
  });

  test("stuckWatch.inspect missing itemId returns error", async () => {
    const result = await callAdminMcpTool("stuckWatch.inspect", {}, demoCred());
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("item_id_required");
  });

  test("stuckWatch.retry denies expected_gate item", async () => {
    const itemId = w1ItemId("C_GATE", "999.001");
    const wakeAt = new Date(Date.now() - 20 * 60_000).toISOString();
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "wake for gate test",
      metadata: {
        reason: "woke",
        channel: "C_GATE",
        ts: "999.001",
        eventId: "EvGate",
      },
      createdAt: wakeAt,
    });
    await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      title: "gate test reply",
      purpose: "comm.internal",
      summary: "pending reply",
      risk: "medium",
      tool: "comm.reply",
      jobId: "job_gate_test",
      metadata: {},
    });

    const classify = await runStuckWatchClassify(DEMO_ORG.id, {
      code: "needs_approval",
    });
    expect(classify.faultClass).toBe("expected_gate");

    const inspect = await callAdminMcpTool(
      "stuckWatch.inspect",
      { itemId },
      demoCred()
    );
    const inspectData = inspect.structuredContent as Record<string, unknown>;
    expect(inspectData.ok).toBe(true);
    const item = inspectData.item as { faultClass: string };
    expect(item.faultClass).toBe("expected_gate");

    const retry = await runStuckWatchRetry(DEMO_ORG.id, { itemId }, "admin_test");
    expect(retry.ok).toBe(false);
    expect(retry.code).toBe("expected_gate_no_retry");
    expect(retry.nextStepJa).toContain("再試行できません");
  });

  test("stuckWatch.retry denies config_drift classification", async () => {
    const classified = await runStuckWatchClassify(DEMO_ORG.id, {
      code: "missing_scope",
    });
    expect(classified.faultClass).toBe("config_drift");
    expect(classified.nextStepJa).toContain("設定不足");

    const driftItemId = w1ItemId(`C_DRIFT_${Date.now()}`, "1.1");
    const channel = driftItemId.split(":")[1] ?? "C_DRIFT";
    const wakeAt = new Date(Date.now() - 20 * 60_000).toISOString();
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_ops",
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "wake drift test",
      metadata: { reason: "woke", channel, ts: "1.1" },
      createdAt: wakeAt,
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
        jobId: "job_drift",
      },
      createdAt: new Date(Date.now() - 19 * 60_000).toISOString(),
    });

    const inspect = await callAdminMcpTool(
      "stuckWatch.inspect",
      { itemId: driftItemId },
      demoCred()
    );
    const inspectData = inspect.structuredContent as Record<string, unknown>;
    expect(inspectData.ok).toBe(true);
    const item = inspectData.item as { faultClass: string };
    expect(item.faultClass).toBe("config_drift");

    const retry = await runStuckWatchRetry(
      DEMO_ORG.id,
      { itemId: driftItemId },
      "admin_test"
    );
    expect(retry.ok).toBe(false);
    expect(retry.code).toBe("config_drift_notify_fix");
  });

  test("stuckWatch.resolve marks item resolved in audit", async () => {
    const channel = `C_RESOLVE_${Date.now()}`;
    const itemId = w1ItemId(channel, "888.001");
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "wake resolve test",
      metadata: {
        reason: "woke",
        channel,
        ts: "888.001",
      },
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });

    const resolved = await runStuckWatchResolve(
      DEMO_ORG.id,
      { itemId, note: "manual fix" },
      "admin_test"
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.item?.status).toBe("resolved");

    const list = await callAdminMcpTool("stuckWatch.list", {}, demoCred());
    const listData = list.structuredContent as { items?: Array<{ id: string; status: string }> };
    const found = listData.items?.find((row) => row.id === itemId);
    if (found) {
      expect(found.status).toBe("resolved");
    }
  });

  test("tool names are in admin catalog", async () => {
    const { ADMIN_MCP_TOOL_NAMES } = await import("@/lib/mcp/admin-public");
    for (const name of [
      "stuckWatch.list",
      "stuckWatch.inspect",
      "stuckWatch.retry",
      "stuckWatch.resolve",
      "stuckWatch.classify",
    ]) {
      expect(ADMIN_MCP_TOOL_NAMES).toContain(name);
    }
  });
});

describe("W2 eligibility regression for admin retry path", () => {
  test("approved unfulfilled W2 item is ops_fault retryable", () => {
    const approval = makeW2Approval();
    expect(isApprovedUnfulfilled(approval)).toBe(true);
    const eligibility = evaluateW2Eligibility({
      approval,
      policy: defaultStuckWatchPolicy(),
      now: new Date(),
    });
    expect(eligibility.eligible).toBe(true);
  });
});
