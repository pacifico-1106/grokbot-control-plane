/**
 * G1 (2026-10-04): the shared approval app ("Staffpass承認") xoxb is an
 * APPROVAL-plane token. Conversation-plane Slack calls (comm.reply / slack.post
 * posts, the user→bot DM fallback, reactions, file uploads, ext-shared probes)
 * must never pick it up via the notification-channel fallback of
 * resolveOrgSlackBotToken. Approval-plane paths keep using it unchanged.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import {
  getEnabledNotificationChannels,
  getNotificationChannelSecretsById,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { postConversationMessage, resolveConversationToken } from "@/lib/gateway/adapters/slack";
import { uploadSlackFile } from "@/lib/gateway/adapters/slack-file-upload";
import { inspectSlackChannelExtShared, resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import { addReaction } from "@/lib/slack/reaction-stamps";
import { resolveApprovalAppBotToken } from "@/lib/slack/authorize-link";

const SHARED_XOXB = "xoxb-shared-approval-app-SECRET";
const originalFetch = globalThis.fetch;
const savedEnv = {
  slack: process.env.SLACK_BOT_TOKEN,
  conversation: process.env.SLACK_CONVERSATION_BOT_TOKEN,
  shared: process.env.SLACK_SHARED_APPROVAL_APP_ENABLED,
  stamps: process.env.SLACK_REACTION_STAMPS,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

type Call = { url: string; auth: string; body: string };
let calls: Call[] = [];

function recordFetch(respond: (url: string, callIndex: number) => Response) {
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      auth: String((init?.headers as Record<string, string> | undefined)?.authorization || ""),
      body: String(init?.body || ""),
    });
    return respond(url, calls.length);
  }) as typeof fetch;
}

function sharedTokenUsed(): boolean {
  return calls.some((call) => call.auth.includes(SHARED_XOXB));
}

async function addSharedInbox(orgId: string): Promise<string> {
  const channel = await upsertNotificationChannel({
    orgId,
    provider: "slack",
    enabled: true,
    label: "Staffpass承認",
    config: { sharedApprovalApp: true, teamId: "T_SHARED_TEAM" },
    secrets: { botToken: SHARED_XOXB },
  });
  return channel.id;
}

let sharedOnlyInboxId = "";
let demoOrgInboxId = "";

beforeAll(async () => {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
  sharedOnlyInboxId = await addSharedInbox("org_shared_only");
  demoOrgInboxId = await addSharedInbox(DEMO_ORG.id);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  restore("SLACK_REACTION_STAMPS", savedEnv.stamps);
});

afterAll(() => {
  restore("SLACK_BOT_TOKEN", savedEnv.slack);
  restore("SLACK_CONVERSATION_BOT_TOKEN", savedEnv.conversation);
  restore("SLACK_SHARED_APPROVAL_APP_ENABLED", savedEnv.shared);
  restore("SLACK_REACTION_STAMPS", savedEnv.stamps);
});

describe("conversation bot token never falls back to the shared approval app", () => {
  test("resolveOrgSlackBotToken skips a shared approval app inbox", async () => {
    expect(await resolveOrgSlackBotToken("org_shared_only")).toBe("");
  });

  test("resolveConversationToken(bot) fails closed with a reason code on a shared-only org", async () => {
    const resolved = await resolveConversationToken({ orgId: "org_shared_only", postingAs: "bot" });
    expect(resolved).toEqual({ error: "slack_conversation_bot_token_missing" });
  });

  test("postingAs=bot on a shared-only org: no Slack call with the shared xoxb (DM with counterpart)", async () => {
    recordFetch(() => Response.json({ ok: true, channel: "D_X", ts: "1503435956.000247" }));
    const result = await postConversationMessage({
      orgId: "org_shared_only",
      postingAs: "bot",
      channel: "D0C2QP30VH6",
      text: "会話の返信",
      slackUserId: "U_COUNTERPART",
    });
    expect(result).toEqual({ ok: false, error: "slack_conversation_bot_token_missing" });
    expect(calls.length).toBe(0);
    expect(sharedTokenUsed()).toBe(false);
  });

  test("postingAs=bot on a shared-only org: no Slack call for a channel post either", async () => {
    recordFetch(() => Response.json({ ok: true, channel: "C_X", ts: "1503435956.000247" }));
    const result = await postConversationMessage({
      orgId: "org_shared_only",
      postingAs: "bot",
      channel: "C0INTERNAL1",
      text: "チャンネル投稿",
    });
    expect(result.ok).toBe(false);
    expect(sharedTokenUsed()).toBe(false);
  });

  test("user token channel_not_found on a DM does NOT fall back to the shared xoxb", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");
    const previousAccounts = emp.allowedAccounts;
    const previousPosting = emp.postingAs;
    emp.allowedAccounts = [...(emp.allowedAccounts ?? []), { service: "slack", accountId: "U_SELF_G1" }];
    emp.postingAs = "user";
    await bindEmployeeSlackIdentity({
      employeeId: emp.id,
      orgId: DEMO_ORG.id,
      slackUserId: "U_SELF_G1",
      slackTeamId: "T_DEMO",
      displayName: "G1 user",
      userToken: "xoxp-user-g1",
    });
    recordFetch((url) => {
      if (url.includes("conversations.open")) return Response.json({ ok: true, channel: { id: "D_APPROVAL_DM" } });
      if (url.includes("chat.postMessage") && calls.length === 1) {
        return Response.json({ ok: false, error: "channel_not_found" });
      }
      return Response.json({ ok: true, channel: "D_APPROVAL_DM", ts: "1503435956.000247" });
    });
    try {
      const result = await postConversationMessage({
        orgId: DEMO_ORG.id,
        employeeId: emp.id,
        postingAs: "user",
        channel: "D0C2QP30VH6",
        text: "DM 返信",
        slackUserId: "U_COUNTERPART",
      });
      expect(result).toEqual({ ok: false, error: "channel_not_found" });
      expect(calls.length).toBe(1);
      expect(calls[0].auth).toBe("Bearer xoxp-user-g1");
      expect(sharedTokenUsed()).toBe(false);
    } finally {
      emp.allowedAccounts = previousAccounts;
      emp.postingAs = previousPosting;
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
    }
  });

  test("reactions (bot) on a shared-only org never use the shared xoxb", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    recordFetch(() => Response.json({ ok: true }));
    const result = await addReaction({
      orgId: "org_shared_only",
      postingAs: "bot",
      channel: "D0C2QP30VH6",
      timestamp: "1503435956.000247",
      reaction: "completed",
    });
    expect(result.ok).toBe(true);
    expect(sharedTokenUsed()).toBe(false);
  });

  test("file upload (bot) on a shared-only org fails closed without calling Slack", async () => {
    recordFetch(() => Response.json({ ok: true }));
    const result = await uploadSlackFile({
      orgId: "org_shared_only",
      postingAs: "bot",
      channel: "C0INTERNAL1",
      threadTs: "1503435956.000247",
      fileRef: "gateway-held:test",
      filename: "a.pdf",
      mimeType: "application/pdf",
      fileBuffer: Buffer.from("%PDF-1.4"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("slack_conversation_bot_token_missing");
    expect(sharedTokenUsed()).toBe(false);
  });

  test("ext-shared probe on a shared-only org does not call Slack with the shared xoxb", async () => {
    recordFetch(() => Response.json({ ok: true, channel: { is_ext_shared: false } }));
    expect(await inspectSlackChannelExtShared("org_shared_only", "C0INTERNAL1")).toBe(null);
    expect(sharedTokenUsed()).toBe(false);
  });
});

describe("ordinary conversation bots keep working", () => {
  test("conversation adapter xoxb is still used (shared inbox present too)", async () => {
    await upsertConversationAdapter({
      orgId: "org_adapter_and_shared",
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-conversation-adapter" },
    });
    await addSharedInbox("org_adapter_and_shared");
    recordFetch(() => Response.json({ ok: true, channel: "C0INTERNAL1", ts: "1503435956.000247" }));
    const result = await postConversationMessage({
      orgId: "org_adapter_and_shared",
      postingAs: "bot",
      channel: "C0INTERNAL1",
      text: "ok",
    });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.auth)).toEqual(["Bearer xoxb-conversation-adapter"]);
  });

  test("a per-tenant Slack notify inbox is still a fallback even when the shared inbox comes first", async () => {
    await addSharedInbox("org_shared_then_tenant");
    await upsertNotificationChannel({
      orgId: "org_shared_then_tenant",
      provider: "slack",
      enabled: true,
      label: "テナント承認アプリ",
      config: { channelId: "C_TENANT_NOTIFY" },
      secrets: { botToken: "xoxb-tenant-notify", signingSecret: "signing" },
    });
    expect(await resolveOrgSlackBotToken("org_shared_then_tenant")).toBe("xoxb-tenant-notify");
    recordFetch(() => Response.json({ ok: true, channel: "C0INTERNAL1", ts: "1503435956.000247" }));
    const result = await postConversationMessage({
      orgId: "org_shared_then_tenant",
      postingAs: "bot",
      channel: "C0INTERNAL1",
      text: "ok",
    });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.auth)).toEqual(["Bearer xoxb-tenant-notify"]);
  });

  test("env SLACK_BOT_TOKEN fallback is unchanged for a shared-only org", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-env-conversation";
    expect(await resolveOrgSlackBotToken("org_shared_only")).toBe("xoxb-env-conversation");
  });

  test("org with no Slack token at all keeps the existing stub behavior", async () => {
    recordFetch(() => Response.json({ ok: true }));
    const result = await postConversationMessage({
      orgId: "org_no_slack_at_all",
      postingAs: "bot",
      channel: "C0INTERNAL1",
      text: "stub",
    });
    expect(result).toEqual({ ok: true, delivery: "stub" });
    expect(calls.length).toBe(0);
  });
});

describe("approval-plane paths still use the shared approval app", () => {
  test("the shared inbox stays an enabled approval notification channel with its xoxb", async () => {
    const channels = await getEnabledNotificationChannels("org_shared_only");
    const shared = channels.find((channel) => channel.id === sharedOnlyInboxId);
    expect(shared?.config?.sharedApprovalApp).toBe(true);
    expect(shared?.secrets.botToken).toBe(SHARED_XOXB);
    expect((await getNotificationChannelSecretsById("org_shared_only", sharedOnlyInboxId)).botToken).toBe(SHARED_XOXB);
  });

  test("#240 link-DM / notice token resolution still returns the shared xoxb", async () => {
    expect(await resolveApprovalAppBotToken("org_shared_only", sharedOnlyInboxId)).toBe(SHARED_XOXB);
    expect(await resolveApprovalAppBotToken(DEMO_ORG.id, demoOrgInboxId)).toBe(SHARED_XOXB);
  });
});
