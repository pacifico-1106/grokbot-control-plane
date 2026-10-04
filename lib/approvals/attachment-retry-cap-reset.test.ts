/**
 * 2026-10-04 (木村, #255 second round, decision 4): the retry-cap reset trigger
 * from the admin MCP dispatcher. Third round (木村 e): read-only setup tools
 * (setup.slackStatus …) never reset, even when they answer ok; a queued ticket,
 * a not-ok answer, or flag OFF records nothing either. diagnoseSlackStatus is stubbed
 * (no Slack). Demo mode, no network.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let diagnoseOk = true;
const real = await import("@/lib/slack/slack-status-diagnose");
mock.module("@/lib/slack/slack-status-diagnose", () => ({
  ...real,
  diagnoseSlackStatus: async () => ({ ok: diagnoseOk, botTokenPresent: true, issues: diagnoseOk ? [] : ["bot_token_invalid"], nextStepJa: "" }),
}));

const { DEMO_ORG, getRuntimeAudit } = await import("@/lib/demo-data");
const { callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { SETUP_TOOL_SUCCEEDED_AUDIT, settingsChangedSince } = await import("@/lib/approvals/attachment-retry-cap");
type ResolvedAdminCredential = import("@/lib/auth/admin-credential").ResolvedAdminCredential;

function adminCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_capreset", status: "linked" });
  return {
    orgId: DEMO_ORG.id, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id,
    generation: agent.credentialGeneration, via: "bearer", agent,
  };
}
const rows = (tool: string) => getRuntimeAudit().filter((e) => e.action === SETUP_TOOL_SUCCEEDED_AUDIT
  && e.orgId === DEMO_ORG.id && (e.metadata as Record<string, unknown>)?.tool === tool);

beforeEach(() => { process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED = "true"; diagnoseOk = true; });
afterEach(() => { delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED; });

describe("setup-type tool succeeded → retry-cap reset marker", () => {
  test("read-only setup.slackStatus ok → no reset (木村 third round e): no setup.tool_succeeded row, no reset signal", async () => {
    const since = new Date(Date.now() - 1).toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const before = rows("setup.slackStatus").length;
    const res = await callAdminMcpTool("setup.slackStatus", {}, adminCred());
    expect((res.structuredContent as Record<string, unknown>).ok).toBe(true);
    expect(rows("setup.slackStatus").length).toBe(before);
    expect(await settingsChangedSince(DEMO_ORG.id, since)).toBe(false);
  });

  test("setup.slackStatus not ok → nothing recorded", async () => {
    diagnoseOk = false;
    const before = rows("setup.slackStatus").length;
    await callAdminMcpTool("setup.slackStatus", {}, adminCred());
    expect(rows("setup.slackStatus").length).toBe(before);
  });

  test("a queued setup ticket (not fulfilled yet) → nothing recorded", async () => {
    process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY ??= "test-key-that-is-at-least-32-characters-long-capreset";
    const before = rows("setup.slackAdapter.setBotToken").length;
    const res = await callAdminMcpTool("setup.slackAdapter.setBotToken", { botToken: "xoxb-capreset-queued" }, adminCred());
    expect((res.structuredContent as Record<string, unknown>).needs_approval).toBe(true);
    expect(rows("setup.slackAdapter.setBotToken").length).toBe(before);
  });

  test("flag OFF → nothing recorded", async () => {
    delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
    const before = rows("setup.slackStatus").length;
    await callAdminMcpTool("setup.slackStatus", {}, adminCred());
    expect(rows("setup.slackStatus").length).toBe(before);
  });
});
