/**
 * H5 (LINE / LINE WORKS design 10/12 §6; 八坂さん decision 3): tenants enter
 * secrets themselves on a screen — a secret never passes through the AI.
 *
 * Admin MCP tools that took a secret as an argument (setup.lineApproval.upsert
 * channelAccessToken / channelSecret, setup.slackAdapter.setBotToken botToken)
 * now refuse it with code secret_argument_refused, the argument NAME only (never
 * the value), and a nextStep naming the screen. Nothing is queued, stored,
 * logged or audited; values already stored stay as they are. Non-secret fields
 * still work. An inventory test keeps new secret-shaped args out of every
 * admin / employee MCP tool schema.
 *
 * Demo mode, dummy values, no network.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ADMIN_MCP_TOOLS, callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import {
  getApprovalById,
  listApprovals,
  listAuditEvents,
  resolveApproval,
  resetDemoNotificationChannels,
  upsertConversationAdapter,
  upsertNotificationChannel,
} from "@/lib/data";
import { getNotificationChannelSecretsById, listNotificationChannels } from "@/lib/data/notification-channels";
import { listConversationAdapters } from "@/lib/data/conversation-adapters";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

const ORG = DEMO_ORG.id;
const STORED_LINE_TOKEN = "stored-line-access-token-value-0001";
const STORED_LINE_SECRET = "stored-line-channel-secret-value-01";
const STORED_BOT_TOKEN = "xoxb-stored-bot-token-value-000001";
const NEW_VALUES: Record<string, string> = {
  channelAccessToken: "new-line-access-token-from-chat-9999",
  channelSecret: "new-line-channel-secret-from-chat-99",
  botToken: "xoxb-new-bot-token-pasted-into-chat-9999",
};
const ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_demo", status: "linked" });
  return { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}

let savedKey: string | undefined;
let savedFetch: typeof globalThis.fetch;
let logged: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  savedKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = ENCRYPTION_KEY;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    if (String(url) === "https://slack.com/api/auth.test") return Response.json({ ok: true, team_id: "TFIX", user_id: "UFIX" });
    if (String(url).startsWith("https://api.line.me/")) return Response.json({});
    throw new Error("unexpected_fixture_endpoint");
  }) as typeof fetch;
  logged = [];
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); })
  );
});
afterEach(async () => {
  for (const s of spies) s.mockRestore();
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = savedKey;
  resetDemoNotificationChannels(ORG);
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

async function seedLine() {
  return upsertNotificationChannel({
    orgId: ORG, provider: "line", enabled: true, isDefault: true, label: "承認 LINE",
    config: { destinationId: "Uboss1234567890abcdef", allowedUserIds: [] },
    secrets: { channelAccessToken: STORED_LINE_TOKEN, channelSecret: STORED_LINE_SECRET },
  });
}

/** Everything the AI / logs / audit / approvals could see must not contain the value. */
async function expectValueNowhere(value: string, result: unknown) {
  expect(JSON.stringify(result)).not.toContain(value);
  expect(logged.join("\n")).not.toContain(value);
  expect(JSON.stringify(await listAuditEvents(ORG, 200))).not.toContain(value);
  expect(JSON.stringify(await listApprovals(ORG))).not.toContain(value);
}

const CASES: Array<{ tool: string; arg: string; base: Record<string, unknown>; screen: RegExp }> = [
  { tool: "setup.lineApproval.upsert", arg: "channelAccessToken", base: { destinationId: "Unew1234567890abcdef" }, screen: /承認を受け取る/ },
  { tool: "setup.lineApproval.upsert", arg: "channelSecret", base: { destinationId: "Unew1234567890abcdef" }, screen: /承認を受け取る/ },
  { tool: "setup.slackAdapter.setBotToken", arg: "botToken", base: {}, screen: /チャンネルに書き込む/ },
];

describe("secret arguments are refused (code, arg name only, screen nextStep)", () => {
  for (const c of CASES) {
    test(`${c.tool} ${c.arg} → secret_argument_refused; nothing queued, logged, audited or stored`, async () => {
      const line = await seedLine();
      await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: true, secrets: { botToken: STORED_BOT_TOKEN } });
      const approvalsBefore = (await listApprovals(ORG)).length;
      const value = NEW_VALUES[c.arg];
      const result = await callAdminMcpTool(c.tool, { ...c.base, ...(c.tool.startsWith("setup.lineApproval") ? { channelId: line.id } : {}), [c.arg]: value }, demoCred());
      const data = result.structuredContent as Record<string, unknown>;
      expect(result.isError).toBe(true);
      expect(data.ok).toBe(false);
      expect(data.code).toBe("secret_argument_refused");
      expect(data.refusedArgs).toEqual([c.arg]);
      expect(data.nextAction).toBe("use_dashboard");
      expect((data.screen as Record<string, unknown>).path).toBe("/app/settings");
      expect(String(data.nextStep)).toMatch(c.screen);
      expect((await listApprovals(ORG)).length).toBe(approvalsBefore);
      await expectValueNowhere(value, result);
      // already-stored values untouched
      expect(await getNotificationChannelSecretsById(ORG, line.id)).toMatchObject({ channelAccessToken: STORED_LINE_TOKEN, channelSecret: STORED_LINE_SECRET });
      const adapters = await listConversationAdapters(ORG);
      expect(adapters.find((a) => a.surface === "slack")?.enabled).toBe(true);
    });
  }

  test("both LINE secrets at once → both names listed, neither value echoed", async () => {
    const result = await callAdminMcpTool("setup.lineApproval.upsert", { destinationId: "Unew1234567890abcdef", channelAccessToken: NEW_VALUES.channelAccessToken, channelSecret: NEW_VALUES.channelSecret }, demoCred());
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("secret_argument_refused");
    expect([...(data.refusedArgs as string[])].sort()).toEqual(["channelAccessToken", "channelSecret"]);
    await expectValueNowhere(NEW_VALUES.channelAccessToken, result);
    await expectValueNowhere(NEW_VALUES.channelSecret, result);
  });

  test("a malformed / wrong-type secret value is refused the same way (never reaches format checks that could quote it)", async () => {
    const result = await callAdminMcpTool("setup.slackAdapter.setBotToken", { botToken: "xoxp-user-token-not-allowed-777" }, demoCred());
    expect((result.structuredContent as Record<string, unknown>).code).toBe("secret_argument_refused");
    await expectValueNowhere("xoxp-user-token-not-allowed-777", result);
  });

  test("re-invoke with an approvalId and a secret is refused too", async () => {
    const result = await callAdminMcpTool("setup.slackAdapter.setBotToken", { approvalId: "apr_does_not_matter", botToken: NEW_VALUES.botToken }, demoCred());
    expect((result.structuredContent as Record<string, unknown>).code).toBe("secret_argument_refused");
    await expectValueNowhere(NEW_VALUES.botToken, result);
  });
});

describe("non-secret fields still work; stored secrets kept", () => {
  test("lineApproval.upsert: update destination / label of an existing channel → queued; after approval the stored secrets are unchanged", async () => {
    const line = await seedLine();
    const result = await callAdminMcpTool("setup.lineApproval.upsert", { channelId: line.id, destinationId: "Cgroup1234567890abcdef", label: "承認グループ" }, demoCred());
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    const approved = await resolveApproval(String(data.approvalId), "approved", "owner@example.com", ORG, { actorId: "mem_human_1" });
    const fulfillment = await fulfillApprovedAdmin(approved!);
    expect(fulfillment?.ok).toBe(true);
    const after = (await listNotificationChannels(ORG)).find((ch) => ch.id === line.id);
    expect(after?.config.destinationId).toBe("Cgroup1234567890abcdef");
    expect(await getNotificationChannelSecretsById(ORG, line.id)).toMatchObject({ channelAccessToken: STORED_LINE_TOKEN, channelSecret: STORED_LINE_SECRET });
  });

  test("lineApproval.upsert: a NEW enabled channel without stored credentials → line_credentials_incomplete pointing to the screen (nothing queued)", async () => {
    const before = (await listApprovals(ORG)).length;
    const result = await callAdminMcpTool("setup.lineApproval.upsert", { destinationId: "Unew1234567890abcdef" }, demoCred());
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("line_credentials_incomplete");
    expect(data.nextAction).toBe("use_dashboard");
    expect(String(data.nextStep)).toMatch(/承認を受け取る/);
    expect((await listApprovals(ORG)).length).toBe(before);
  });

  test("setBotToken: disabling (enabled=false) is still queued; enabling without a token points to the screen", async () => {
    const off = await callAdminMcpTool("setup.slackAdapter.setBotToken", { enabled: false }, demoCred());
    expect((off.structuredContent as Record<string, unknown>).needs_approval).toBe(true);
    const on = await callAdminMcpTool("setup.slackAdapter.setBotToken", {}, demoCred());
    const data = on.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("slack_adapter_token_required");
    expect(data.nextAction).toBe("use_dashboard");
    expect(String(data.nextStep)).toMatch(/チャンネルに書き込む/);
  });
});

/**
 * Inventory: every schema property whose name looks like a secret, in every
 * admin and employee MCP tool. A new one fails here until it is either
 * refused (and removed from the schema) or listed below with a reason.
 */
const SECRET_NAME = /token|secret|password|passwd|api_?key|private_?key|signing|bearer|cookie|webhook_?url|credential/i;
const REVIEWED_NON_SECRET_OR_OPEN: Record<string, string> = {
  // Staffpass-issued, per-approval capability to poll its status (not a tenant secret).
  "employee:staffpass_get_approval_status.statusToken": "staffpass_capability",
  // Open decision (PR body): only other route is invite=true, which needs the recovery mail.
  "admin:orgs.create.ownerPassword": "open_decision",
};
function secretNamedProps(prefix: string, schema: unknown, out: string[]) {
  if (!schema || typeof schema !== "object") return;
  const props = (schema as { properties?: Record<string, unknown> }).properties || {};
  for (const [k, v] of Object.entries(props)) {
    const path = `${prefix}.${k}`;
    if (SECRET_NAME.test(k)) out.push(path);
    secretNamedProps(path, v, out);
    const items = (v as { items?: unknown })?.items;
    if (items) secretNamedProps(`${path}[]`, items, out);
  }
}

describe("inventory: no secret-shaped argument in any MCP tool schema", () => {
  test("admin + employee MCP tools: only reviewed exceptions remain", () => {
    const found: string[] = [];
    for (const t of ADMIN_MCP_TOOLS) secretNamedProps(`admin:${t.name}`, t.inputSchema, found);
    for (const t of STAFFPASS_MCP_TOOLS) secretNamedProps(`employee:${t.name}`, t.inputSchema, found);
    expect(found.filter((p) => !(p in REVIEWED_NON_SECRET_OR_OPEN)).sort()).toEqual([]);
  });
  test("the refused tools describe where the tenant enters the secret", () => {
    const line = ADMIN_MCP_TOOLS.find((t) => t.name === "setup.lineApproval.upsert")!;
    const bot = ADMIN_MCP_TOOLS.find((t) => t.name === "setup.slackAdapter.setBotToken")!;
    expect(line.description).toContain("/app/settings");
    expect(bot.description).toContain("/app/settings");
  });
});
