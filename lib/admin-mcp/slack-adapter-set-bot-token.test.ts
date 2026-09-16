import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import {
  getApprovalById,
  listAuditEvents,
  resolveApproval,
  upsertConversationAdapter,
} from "@/lib/data";
import { getEnabledConversationAdapter } from "@/lib/data/conversation-adapters";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

const TEST_TOKEN = "xoxb-test-admin-mcp-slack-adapter-secret";
const ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";
const originalFetch = globalThis.fetch;
const originalKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;

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

function jsonHasNoToken(value: unknown, token: string): boolean {
  const text = JSON.stringify(value);
  return !text.includes(token);
}

beforeEach(() => {
  globalThis.fetch = (async (url) => {
    if (String(url) !== "https://slack.com/api/auth.test") throw new Error("unexpected_fixture_endpoint");
    return Response.json({ ok: true, team_id: "TFIXTURE", user_id: "UFIXTURE" });
  }) as typeof fetch;
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = originalKey;
  await upsertConversationAdapter({
    orgId: DEMO_ORG.id,
    surface: "slack",
    enabled: false,
    secrets: {},
  });
});

describe("setup.slackAdapter.setBotToken", () => {
  test("is registered in admin MCP catalog", () => {
    expect(ADMIN_MCP_TOOL_NAMES).toContain("setup.slackAdapter.setBotToken");
  });

  test("queues always_human approval without mutating adapter", async () => {
    const before = await getEnabledConversationAdapter(DEMO_ORG.id, "slack");
    expect(before).toBeNull();

    const result = await callAdminMcpTool(
      "setup.slackAdapter.setBotToken",
      { botToken: TEST_TOKEN },
      demoCred()
    );
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(data.auditClass).toBe("admin");
    expect(data.auditAction).toBe("admin.conversationAdapter");
    expect(data.approvalId).toBeTruthy();
    expect(jsonHasNoToken(data, TEST_TOKEN)).toBe(true);

    const approval = await getApprovalById(String(data.approvalId), DEMO_ORG.id);
    expect(approval).toBeTruthy();
    expect(jsonHasNoToken(approval?.metadata, TEST_TOKEN)).toBe(true);
    expect(approval?.metadata?.adminMutation).toMatchObject({
      enabled: true,
      botTokenPresent: true,
    });
    expect(String((approval?.metadata?.adminMutation as Record<string, unknown>)?.botToken || "")).toBe("");

    expect(await getEnabledConversationAdapter(DEMO_ORG.id, "slack")).toBe(before);
  });

  test("rejects empty token when enabled", async () => {
    const result = await callAdminMcpTool(
      "setup.slackAdapter.setBotToken",
      { botToken: "   " },
      demoCred()
    );
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("slack_adapter_token_required");
    expect(result.isError).toBe(true);
  });

  test("rejects non-xoxb token format", async () => {
    const result = await callAdminMcpTool(
      "setup.slackAdapter.setBotToken",
      { botToken: "xoxp-user-token-not-allowed" },
      demoCred()
    );
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("invalid_bot_token_format");
    expect(result.isError).toBe(true);
  });

  test("fulfill stores encrypted token without echoing secret", async () => {
    const queued = await callAdminMcpTool(
      "setup.slackAdapter.setBotToken",
      { botToken: TEST_TOKEN, label: "Slack 会話投稿" },
      demoCred()
    );
    const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId);

    const approved = await resolveApproval(
      approvalId,
      "approved",
      "owner@example.com",
      DEMO_ORG.id,
      { actorId: "mem_human_1" }
    );
    expect(approved?.status).toBe("approved");

    const fulfillment = await fulfillApprovedAdmin(approved!);
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.tool).toBe("setup.slackAdapter.setBotToken");
    expect(fulfillment?.botTokenPresent).toBe(true);
    expect(fulfillment?.hasCredentials).toBe(true);
    expect(jsonHasNoToken(fulfillment, TEST_TOKEN)).toBe(true);

    const runtime = await getEnabledConversationAdapter(DEMO_ORG.id, "slack");
    expect(runtime?.secrets.botToken).toBe(TEST_TOKEN);

    const audits = await listAuditEvents(DEMO_ORG.id, 20);
    const fulfillAudit = audits.find((event) => event.action === "admin.conversationAdapter");
    expect(fulfillAudit).toBeTruthy();
    expect(jsonHasNoToken(fulfillAudit, TEST_TOKEN)).toBe(true);
    expect(fulfillAudit?.metadata).toMatchObject({
      auditClass: "admin",
      surface: "slack",
      enabled: true,
      botTokenPresent: true,
    });
  });
});
