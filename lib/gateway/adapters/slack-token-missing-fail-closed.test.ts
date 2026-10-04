/**
 * 2026-10-04 (木村 decision 1 + 2): production fails closed when no Slack token.
 *
 * - No conversation token in PRODUCTION → `{ ok:false, error:"slack_token_missing" }`
 *   instead of the silent `{ ok:true, delivery:"stub" }` that looked like a sent post.
 *   The stub stays only in demo mode (isDemoMode(): Supabase not configured = local / tests).
 * - The env SLACK_BOT_TOKEN / SLACK_CONVERSATION_BOT_TOKEN fallback is gone: in
 *   multi-tenant production it can be another workspace's bot.
 *
 * Production mode is simulated by mocking @/lib/mode plus the three data modules
 * that would otherwise need Supabase. Slack fetch is recorded, never real.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realMode from "@/lib/mode";
import * as realAdapters from "@/lib/data/conversation-adapters";
import * as realChannels from "@/lib/data/notification-channels";
import * as realIdentities from "@/lib/data/slack-identities";
import type { MouthRoutingDecision } from "@/lib/types";

let demo = false;
const adapterTokens = new Map<string, string>();
const notifyChannels = new Map<string, Array<{ provider: string; config: Record<string, unknown>; secrets: Record<string, string> }>>();

mock.module("@/lib/mode", () => ({ ...realMode, isDemoMode: () => demo, isSupabaseConfigured: () => !demo }));
mock.module("@/lib/data/conversation-adapters", () => ({
  ...realAdapters,
  getEnabledConversationAdapter: async (orgId: string) => {
    const token = adapterTokens.get(orgId);
    return token ? { orgId, surface: "slack", enabled: true, config: {}, secrets: { botToken: token } } : null;
  },
}));
mock.module("@/lib/data/notification-channels", () => ({
  ...realChannels,
  getEnabledNotificationChannels: async (orgId: string) => notifyChannels.get(orgId) ?? [],
}));
mock.module("@/lib/data/slack-identities", () => ({
  ...realIdentities,
  getLinkedSlackUserToken: async () => null,
}));

const slack = await import("@/lib/gateway/adapters/slack");
const { uploadSlackFile } = await import("@/lib/gateway/adapters/slack-file-upload");
const { resolveOrgSlackBotToken, resolveOrgSlackBotTokenDetailed } = await import("@/lib/slack/bot-token");
const { addReaction } = await import("@/lib/slack/reaction-stamps");

const originalFetch = globalThis.fetch;
const savedEnv = {
  slack: process.env.SLACK_BOT_TOKEN,
  conversation: process.env.SLACK_CONVERSATION_BOT_TOKEN,
  stamps: process.env.SLACK_REACTION_STAMPS,
};
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let calls: Array<{ url: string; auth: string }> = [];
function recordFetch() {
  calls = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      auth: String((init?.headers as Record<string, string> | undefined)?.authorization || ""),
    });
    return Response.json({ ok: true, channel: "C0INTERNAL1", ts: "1503435956.000247" });
  }) as typeof fetch;
}

beforeEach(() => {
  demo = false;
  adapterTokens.clear();
  notifyChannels.clear();
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  recordFetch();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  restore("SLACK_BOT_TOKEN", savedEnv.slack);
  restore("SLACK_CONVERSATION_BOT_TOKEN", savedEnv.conversation);
  restore("SLACK_REACTION_STAMPS", savedEnv.stamps);
});

const ORG = "org_prod_no_token";

describe("decision 1: production fails closed with slack_token_missing", () => {
  test("SLACK_TOKEN_MISSING is the reason code (already a retryable code in the approval claim)", () => {
    expect(slack.SLACK_TOKEN_MISSING).toBe("slack_token_missing");
  });

  test("postConversationMessage (comm.reply / comm.send / slack.post / approval fulfill) → failure, no Slack call", async () => {
    const result = await slack.postConversationMessage({ orgId: ORG, postingAs: "bot", channel: "C0INTERNAL1", text: "hi" });
    expect(result).toEqual({ ok: false, error: "slack_token_missing" });
    expect(calls).toEqual([]);
  });

  test("demo mode keeps the stub (local / tests only)", async () => {
    demo = true;
    const result = await slack.postConversationMessage({ orgId: ORG, postingAs: "bot", channel: "C0INTERNAL1", text: "hi" });
    expect(result).toEqual({ ok: true, delivery: "stub" });
    expect(calls).toEqual([]);
  });

  test("postConversationMessageWithReplyPolicy passes the failure through (no stub ok)", async () => {
    const result = await slack.postConversationMessageWithReplyPolicy({
      orgId: ORG,
      postingAs: "bot",
      channel: "C0INTERNAL1",
      text: "hi",
      // Inside default business hours, so the policy posts (not draft / hold).
      currentTime: new Date("2026-10-05T02:00:00Z"),
      timezone: "Asia/Tokyo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("slack_token_missing");
    expect(calls).toEqual([]);
  });

  test("executeSlackSplitRouting channel delivery is a failure, not a stub ok", async () => {
    const routing = {
      channelRoute: { path: { kind: "channel" }, contentVariant: "full", auditLabel: "channel" },
      internalRoute: null,
      splitDelivery: false,
    } as unknown as MouthRoutingDecision;
    const result = await slack.executeSlackSplitRouting({
      orgId: ORG,
      postingAs: "bot",
      channelId: "C0INTERNAL1",
      externalSafeText: "safe",
      internalFullText: "full",
      routing,
    });
    expect(result.channelDelivery).toEqual({ ok: false, error: "slack_token_missing" });
    expect(calls).toEqual([]);
  });

  test("file attachment upload → slack_token_missing (already fail-closed, locked in)", async () => {
    const result = await uploadSlackFile({
      orgId: ORG,
      postingAs: "bot",
      channel: "C0INTERNAL1",
      threadTs: "1503435956.000247",
      fileRef: "https://files.example.invalid/a.pdf",
      fileUrl: "https://files.example.invalid/a.pdf",
      filename: "a.pdf",
    } as Parameters<typeof uploadSlackFile>[0]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("slack_token_missing");
    expect(calls).toEqual([]);
  });

  test("reactions stay optional for callers but never a quiet ok: explicit not-registered, no Slack call", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    const result = await addReaction({ orgId: ORG, channel: "C0INTERNAL1", timestamp: "1503435956.000247", reaction: "completed" });
    expect(result).toEqual({ ok: false, error: "conversation_bot_token_not_registered", degraded: true });
    expect(calls).toEqual([]);
  });

  test("shared-approval-only org keeps its specific code (slack_conversation_bot_token_missing)", async () => {
    notifyChannels.set(ORG, [{ provider: "slack", config: { sharedApprovalApp: true, teamId: "T_SHARED" }, secrets: { botToken: "xoxb-shared-SECRET" } }]);
    const result = await slack.postConversationMessage({ orgId: ORG, postingAs: "bot", channel: "C0INTERNAL1", text: "hi" });
    expect(result).toEqual({ ok: false, error: "slack_conversation_bot_token_missing" });
    expect(calls).toEqual([]);
  });

  test("control: the org's own conversation adapter token still posts", async () => {
    adapterTokens.set(ORG, "xoxb-own-adapter");
    const result = await slack.postConversationMessage({ orgId: ORG, postingAs: "bot", channel: "C0INTERNAL1", text: "hi" });
    expect(result).toEqual({ ok: true, delivery: "slack", channel: "C0INTERNAL1", ts: "1503435956.000247" });
    expect(calls.map((call) => call.auth)).toEqual(["Bearer xoxb-own-adapter"]);
  });

  test("control: the org's own (non-shared) notify inbox token still posts", async () => {
    notifyChannels.set(ORG, [{ provider: "slack", config: { channelId: "C_NOTIFY" }, secrets: { botToken: "xoxb-own-notify" } }]);
    const result = await slack.postConversationMessage({ orgId: ORG, postingAs: "bot", channel: "C0INTERNAL1", text: "hi" });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.auth)).toEqual(["Bearer xoxb-own-notify"]);
  });
});

describe("decision 2: env SLACK_BOT_TOKEN / SLACK_CONVERSATION_BOT_TOKEN is never used", () => {
  for (const name of ["SLACK_BOT_TOKEN", "SLACK_CONVERSATION_BOT_TOKEN"] as const) {
    test(`${name} set, org has no token of its own → no token, post fails, env bot never called`, async () => {
      process.env[name] = "xoxb-env-OTHER-WORKSPACE";
      expect(await resolveOrgSlackBotToken(ORG)).toBe("");
      expect(await resolveOrgSlackBotTokenDetailed(ORG)).toEqual({ token: "", skippedSharedApprovalApp: false });
      const result = await slack.postConversationMessage({ orgId: ORG, postingAs: "bot", channel: "C0INTERNAL1", text: "hi" });
      expect(result).toEqual({ ok: false, error: "slack_token_missing" });
      process.env.SLACK_REACTION_STAMPS = "true";
      await addReaction({ orgId: ORG, channel: "C0INTERNAL1", timestamp: "1503435956.000247", reaction: "completed" });
      expect(calls.some((call) => call.auth.includes("xoxb-env-OTHER-WORKSPACE"))).toBe(false);
      expect(calls).toEqual([]);
    });
  }

  test("env set + shared-approval-only org → still the shared-app code, never the env bot", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-env-OTHER-WORKSPACE";
    notifyChannels.set(ORG, [{ provider: "slack", config: { sharedApprovalApp: true, teamId: "T_SHARED" }, secrets: { botToken: "xoxb-shared-SECRET" } }]);
    const result = await slack.postConversationMessage({ orgId: ORG, postingAs: "bot", channel: "C0INTERNAL1", text: "hi" });
    expect(result).toEqual({ ok: false, error: "slack_conversation_bot_token_missing" });
    expect(calls).toEqual([]);
  });

  test("user-token DM retry (Path A) never falls back to the env bot either", async () => {
    // postingAs=user with no linked identity is slack_identity_unbound before any Slack call.
    process.env.SLACK_BOT_TOKEN = "xoxb-env-OTHER-WORKSPACE";
    const result = await slack.postConversationMessage({
      orgId: ORG, employeeId: "emp_x", postingAs: "user", channel: "D0DM00001", text: "hi", slackUserId: "U0AAAA",
    });
    expect(result).toEqual({ ok: false, error: "slack_identity_unbound" });
    expect(calls).toEqual([]);
  });
});
