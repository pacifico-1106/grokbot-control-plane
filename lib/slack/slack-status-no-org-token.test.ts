/**
 * 2026-10-04 (木村, #252): after the env SLACK_BOT_TOKEN fallback is removed, an org
 * with no conversation bot token of its own must
 *  1. never be reported ok / ready from the env token (or a stub), and
 *  2. get a clear status (`conversation_bot_token_not_registered`) and the next
 *     step (`setup.slackAdapter.setBotToken`).
 * Covers setup.slackStatus (diagnoseSlackStatus + the Admin MCP tool) and the
 * reaction-stamp path that used to fall back to the env bot.
 * Demo mode, dummy values, Slack fetch recorded, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { diagnoseSlackStatus } from "@/lib/slack/slack-status-diagnose";
import { addReaction, removeReaction } from "@/lib/slack/reaction-stamps";

const ENV_BOT = "xoxb-env-other-workspace-dummy";
const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; auth: string }> = [];
function withEnvBotAndRecordedSlack() {
  process.env.SLACK_BOT_TOKEN = ENV_BOT;
  process.env.SLACK_CONVERSATION_BOT_TOKEN = ENV_BOT;
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get("authorization") || "" });
    // Anything reaching Slack would look healthy: the test proves nothing is asked.
    return Response.json({ ok: true, bot_id: "B_ENV", user_id: "U_ENV", team_id: "T_OTHER", upload_url: "https://files.slack.com/x", file_id: "F1" });
  }) as typeof fetch;
}
afterEach(async () => {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  delete process.env.SLACK_REACTION_STAMPS;
  globalThis.fetch = originalFetch;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_status_no_token", status: "linked" });
  return {
    orgId: DEMO_ORG.id, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent,
  };
}

describe("setup.slackStatus: org without its own conversation bot token", () => {
  test("diagnoseSlackStatus: env token present → still not ok, explicit not_registered status and setBotToken next step", async () => {
    withEnvBotAndRecordedSlack();
    const status = await diagnoseSlackStatus("org_status_no_token_1");
    expect(status.ok).toBe(false);
    expect(status.botTokenPresent).toBe(false);
    expect(status.authTest).toBeNull();
    expect(calls.filter((c) => c.auth.includes(ENV_BOT))).toEqual([]);
    expect(calls).toEqual([]);
    expect(status.conversationBotToken).toEqual({
      status: "not_registered",
      code: "conversation_bot_token_not_registered",
      nextTool: "setup.slackAdapter.setBotToken",
    });
    expect(status.nextTool).toBe("setup.slackAdapter.setBotToken");
    expect(status.issues.some((i) => i.includes("conversation bot token not registered"))).toBe(true);
    expect(status.nextStepJa).toContain("setup.slackAdapter.setBotToken");
    expect(JSON.stringify(status)).not.toContain(ENV_BOT);
  });

  test("Admin MCP setup.slackStatus (DEMO org, adapter disabled) reports the same, never ready", async () => {
    withEnvBotAndRecordedSlack();
    await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} });
    const result = await callAdminMcpTool("setup.slackStatus", {}, demoCred());
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.botTokenPresent).toBe(false);
    expect((body.conversationBotToken as Record<string, unknown>).code).toBe("conversation_bot_token_not_registered");
    expect(body.nextTool).toBe("setup.slackAdapter.setBotToken");
    expect(calls.filter((c) => c.auth.includes(ENV_BOT))).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(ENV_BOT);
  });

  test("org token registered → status registered, nextTool not the setBotToken step", async () => {
    withEnvBotAndRecordedSlack();
    await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-org-own-dummy" } });
    const status = await diagnoseSlackStatus(DEMO_ORG.id);
    expect(status.botTokenPresent).toBe(true);
    expect(status.conversationBotToken).toEqual({ status: "registered" });
    expect(status.nextTool).not.toBe("setup.slackAdapter.setBotToken");
    expect(calls.some((c) => c.auth === "Bearer xoxb-org-own-dummy")).toBe(true);
    expect(calls.filter((c) => c.auth.includes(ENV_BOT))).toEqual([]);
  });
});

describe("reaction stamps: org without its own token", () => {
  test("addReaction: env token present → not ok, explicit code, nothing sent with the env bot", async () => {
    withEnvBotAndRecordedSlack();
    process.env.SLACK_REACTION_STAMPS = "true";
    const r = await addReaction({ orgId: "org_status_no_token_2", channel: "C1", timestamp: "1787911797.502889", reaction: "looking" });
    expect(r).toMatchObject({ ok: false, error: "conversation_bot_token_not_registered", degraded: true });
    expect(calls).toEqual([]);
  });

  test("removeReaction: same", async () => {
    withEnvBotAndRecordedSlack();
    process.env.SLACK_REACTION_STAMPS = "true";
    const r = await removeReaction({ orgId: "org_status_no_token_2", channel: "C1", timestamp: "1787911797.502889", reaction: "looking" });
    expect(r).toMatchObject({ ok: false, error: "conversation_bot_token_not_registered", degraded: true });
    expect(calls).toEqual([]);
  });
});
