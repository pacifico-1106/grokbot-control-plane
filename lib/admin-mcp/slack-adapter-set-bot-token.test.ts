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

let savedFetch: typeof globalThis.fetch;
let savedEncryptionKey: string | undefined;

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
  savedFetch = globalThis.fetch;
  savedEncryptionKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  globalThis.fetch = (async (url) => {
    if (String(url) !== "https://slack.com/api/auth.test") throw new Error("unexpected_fixture_endpoint");
    return Response.json({ ok: true, team_id: "TFIXTURE", user_id: "UFIXTURE" });
  }) as typeof fetch;
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  if (savedEncryptionKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = savedEncryptionKey;
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

  // H5 (10/12): the token is entered on the screen (/app/settings「チャンネルに
  // 書き込む（会社のBot）」); the tool refuses it and can only disable.
  test("a botToken argument is refused: nothing queued, adapter untouched, token not echoed", async () => {
    const before = await getEnabledConversationAdapter(DEMO_ORG.id, "slack");
    const result = await callAdminMcpTool("setup.slackAdapter.setBotToken", { botToken: TEST_TOKEN }, demoCred());
    const data = result.structuredContent as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(data.code).toBe("secret_argument_refused");
    expect(data.approvalId).toBeUndefined();
    expect(jsonHasNoToken(result, TEST_TOKEN)).toBe(true);
    expect(await getEnabledConversationAdapter(DEMO_ORG.id, "slack")).toBe(before);
  });

  test("an empty / malformed token value is refused the same way (the argument itself is retired)", async () => {
    for (const botToken of ["   ", "xoxp-user-token-not-allowed"]) {
      const result = await callAdminMcpTool("setup.slackAdapter.setBotToken", { botToken }, demoCred());
      expect((result.structuredContent as Record<string, unknown>).code).toBe("secret_argument_refused");
      expect(result.isError).toBe(true);
    }
  });

  test("enabling without a token → slack_adapter_token_required with the screen as nextStep", async () => {
    const result = await callAdminMcpTool("setup.slackAdapter.setBotToken", { label: "Slack 会話投稿" }, demoCred());
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("slack_adapter_token_required");
    expect(data.nextAction).toBe("use_dashboard");
    expect(String(data.nextStep)).toContain("/app/settings");
  });

  test("disable (enabled=false) is queued and, after approval, keeps the stored token but turns the adapter off", async () => {
    await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: TEST_TOKEN } });
    const queued = await callAdminMcpTool("setup.slackAdapter.setBotToken", { enabled: false }, demoCred());
    const data = queued.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    const approved = await resolveApproval(String(data.approvalId), "approved", "owner@example.com", DEMO_ORG.id, { actorId: "mem_human_1" });
    expect(approved?.status).toBe("approved");
    const fulfillment = await fulfillApprovedAdmin(approved!);
    expect(fulfillment?.ok).toBe(true);
    expect(jsonHasNoToken(fulfillment, TEST_TOKEN)).toBe(true);
    expect(await getEnabledConversationAdapter(DEMO_ORG.id, "slack")).toBeNull();
    const audits = await listAuditEvents(DEMO_ORG.id, 20);
    const fulfillAudit = audits.find((event) => event.action === "admin.conversationAdapter");
    expect(jsonHasNoToken(fulfillAudit, TEST_TOKEN)).toBe(true);
    expect(fulfillAudit?.metadata).toMatchObject({ auditClass: "admin", surface: "slack", enabled: false });
    expect((await getApprovalById(String(data.approvalId), DEMO_ORG.id))?.metadata?.adminMutation).toMatchObject({ enabled: false, botTokenPresent: false });
  });
});
