import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import {
  getApprovalById,
  getEmployee,
  listAuditEvents,
  listNotificationChannels,
  resolveApproval,
  resetDemoNotificationChannels,
  resolveEmployeeApprovalChannel,
  upsertNotificationChannel,
} from "@/lib/data";
import { issueEmployee } from "@/lib/data/employees";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { diagnoseLineApprovalStatus } from "@/lib/line/line-approval-status-diagnose";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ApprovalRequest, Employee } from "@/lib/types";

const ORG = DEMO_ORG.id;
const LINE_TOKEN = "line-access-token-secret-test-value";
const LINE_SECRET = "line-channel-secret-test-value";
const TELEGRAM_TOKEN = "telegram-bot-token-secret-test";
const ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";
const originalKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
const originalFetch = globalThis.fetch;

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({
    grokBotAgentId: "grok_admin_demo",
    status: "linked",
  });
  return {
    orgId: ORG,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

function jsonHasNoSecret(value: unknown, secret: string): boolean {
  return !JSON.stringify(value).includes(secret);
}

async function seedLineDefault() {
  return upsertNotificationChannel({
    orgId: ORG,
    provider: "line",
    enabled: true,
    isDefault: true,
    label: "Space Tree 承認",
    config: { destinationId: "Uboss1234567890abcdef", allowedUserIds: ["Uboss1234567890abcdef"] },
    secrets: { channelAccessToken: LINE_TOKEN, channelSecret: LINE_SECRET },
  });
}

async function seedTelegramDefault() {
  return upsertNotificationChannel({
    orgId: ORG,
    provider: "telegram",
    enabled: true,
    isDefault: true,
    label: "旧 Telegram",
    config: { chatId: "111", allowedUserIds: [] },
    secrets: { botToken: TELEGRAM_TOKEN, webhookSecret: "whsec-test" },
  });
}

function approval(orgId: string, employee?: Partial<Employee>): ApprovalRequest {
  return {
    id: "apr_line_admin_mcp",
    orgId,
    employeeId: employee?.id || "emp_line_test",
    credentialId: "cred_line_test",
    title: "承認依頼: mail.send",
    purpose: "sales.outreach",
    summary: "LINE 承認テスト",
    risk: "high",
    status: "pending",
    tool: "mail.send",
    jobId: "job_line_test",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    telegramRef: "lineref12345",
    telegramMessageId: null,
    metadata: {},
    statusToken: "st_line_test",
    pollPath: "/api/approvals/status?id=x&token=y",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  };
}

beforeEach(() => {
  globalThis.fetch = (async (url) => {
    if (!String(url).startsWith("https://api.line.me/")) throw new Error("unexpected_fixture_endpoint");
    return Response.json({});
  }) as typeof fetch;
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = originalKey;
  globalThis.fetch = originalFetch;
  resetDemoNotificationChannels(ORG);
});

describe("setup.lineApprovalStatus", () => {
  test("is registered and returns no secrets", async () => {
    expect(ADMIN_MCP_TOOL_NAMES).toContain("setup.lineApprovalStatus");
    await seedLineDefault();
    const result = await callAdminMcpTool("setup.lineApprovalStatus", {}, demoCred());
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.channels)).toBe(true);
    expect(jsonHasNoSecret(data, LINE_TOKEN)).toBe(true);
    expect(jsonHasNoSecret(data, LINE_SECRET)).toBe(true);
    expect(String(data.confusionNoteJa || "")).toContain("承認用LINE");
    expect(String(data.nextStepJa || "")).toContain("Webhook");
  });

  test("diagnose maps destination kind without echoing full destinationId", async () => {
    const saved = await seedLineDefault();
    const status = await diagnoseLineApprovalStatus(ORG);
    expect(status.channels[0]?.id).toBe(saved.id);
    expect(status.channels[0]?.destinationKind).toBe("user");
    expect(status.channels[0]?.destinationPresent).toBe(true);
    expect(JSON.stringify(status.channels[0])).not.toContain("Uboss1234567890abcdef");
  });
});

describe("setup.lineApproval.upsert", () => {
  test("maps to admin.notificationChannel audit action", () => {
    expect(auditActionForAdminTool("setup.lineApproval.upsert")).toBe("admin.notificationChannel");
  });

  test("queues always_human without storing raw tokens in metadata", async () => {
    const result = await callAdminMcpTool(
      "setup.lineApproval.upsert",
      {
        channelAccessToken: LINE_TOKEN,
        channelSecret: LINE_SECRET,
        destinationId: "Uboss1234567890abcdef",
        isDefault: true,
      },
      demoCred()
    );
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(data.auditAction).toBe("admin.notificationChannel");
    expect(jsonHasNoSecret(data, LINE_TOKEN)).toBe(true);
    expect(jsonHasNoSecret(data, LINE_SECRET)).toBe(true);

    const approvalRow = await getApprovalById(String(data.approvalId), ORG);
    expect(jsonHasNoSecret(approvalRow?.metadata, LINE_TOKEN)).toBe(true);
    expect(jsonHasNoSecret(approvalRow?.metadata, LINE_SECRET)).toBe(true);
    expect((approvalRow?.metadata?.adminMutation as Record<string, unknown>)?.secretsCiphertext).toBeTruthy();
  });

  test("fulfill stores encrypted credentials and audit has no token", async () => {
    const queued = await callAdminMcpTool(
      "setup.lineApproval.upsert",
      {
        channelAccessToken: LINE_TOKEN,
        channelSecret: LINE_SECRET,
        destinationId: "Uboss1234567890abcdef",
        label: "Space Tree 承認",
        isDefault: true,
      },
      demoCred()
    );
    const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId);
    const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, {
      actorId: "mem_human_1",
    });
    const fulfillment = await fulfillApprovedAdmin(approved!);
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.destinationPresent).toBe(true);
    expect(fulfillment?.webhookPath).toContain("/api/webhooks/line/");
    expect(jsonHasNoSecret(fulfillment, LINE_TOKEN)).toBe(true);

    const audits = await listAuditEvents(ORG, 20);
    const fulfillAudit = audits.find((event) => event.action === "admin.notificationChannel");
    expect(fulfillAudit).toBeTruthy();
    expect(jsonHasNoSecret(fulfillAudit, LINE_TOKEN)).toBe(true);
  });
});

describe("setup.lineApproval.setEmployeeInbox", () => {
  test("validates org line channel before queue", async () => {
    const line = await seedLineDefault();
    const issued = await issueEmployee({
      orgId: ORG,
      displayName: "Space Tree AI",
      roleLabel: "窓口",
      jobDescription: "",
      scopes: ["mail:send"],
      allowedPurposes: [],
      approvalPolicy: "always_human",
      spend: null,
      allowedAccounts: [],
      secretHash: "hash",
      secretPrefix: "gb_emp_test",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      auditSummary: "test hire",
    });

    const bad = await callAdminMcpTool(
      "setup.lineApproval.setEmployeeInbox",
      { employeeId: issued.employee.id, approvalChannelId: "chn_missing" },
      demoCred()
    );
    expect((bad.structuredContent as Record<string, unknown>).code).toBe("line_approval_channel_not_found");

    const queued = await callAdminMcpTool(
      "setup.lineApproval.setEmployeeInbox",
      { employeeId: issued.employee.id, approvalChannelId: line.id },
      demoCred()
    );
    const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId);
    const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, {
      actorId: "mem_human_1",
    });
    await fulfillApprovedAdmin(approved!);
    const updated = await getEmployee(issued.employee.id, ORG);
    expect(updated?.approvalChannelId).toBe(line.id);
  });
});

describe("setup.lineApproval.demoteTelegram", () => {
  test("disable mode stops telegram from being active approval path", async () => {
    const line = await seedLineDefault();
    const telegram = await seedTelegramDefault();
    const issued = await issueEmployee({
      orgId: ORG,
      displayName: "Space Tree AI",
      roleLabel: "窓口",
      jobDescription: "",
      scopes: ["mail:send"],
      allowedPurposes: [],
      approvalPolicy: "always_human",
      approvalChannelId: line.id,
      spend: null,
      allowedAccounts: [],
      secretHash: "hash2",
      secretPrefix: "gb_emp_test2",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      auditSummary: "test hire 2",
    });

    const pushTargets: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as { to?: string };
      pushTargets.push(String(payload.to || ""));
      return Response.json({});
    }) as typeof fetch;

    const resolved = await resolveEmployeeApprovalChannel(ORG, issued.employee);
    expect(resolved?.provider).toBe("line");
    await sendApprovalNotifications(approval(ORG, issued.employee), issued.employee);
    expect(pushTargets.length).toBe(1);
    expect(pushTargets[0]).toBe("Uboss1234567890abcdef");

    const queued = await callAdminMcpTool(
      "setup.lineApproval.demoteTelegram",
      { mode: "disable", channelId: telegram.id },
      demoCred()
    );
    const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId);
    const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, {
      actorId: "mem_human_1",
    });
    await fulfillApprovedAdmin(approved!);

    const listed = await listNotificationChannels(ORG);
    const demoted = listed.find((row) => row.id === telegram.id);
    expect(demoted?.enabled).toBe(false);
    expect(demoted?.isDefault).toBe(false);

    const status = await diagnoseLineApprovalStatus(ORG);
    expect(status.telegramApprovalEnabled).toBe(false);
    expect(status.telegramIsDefault).toBe(false);
  });
});
