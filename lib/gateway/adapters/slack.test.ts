import { afterEach, describe, expect, test } from "bun:test";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertNotificationChannel } from "@/lib/data/notification-channels";
import {
  bindEmployeeSlackIdentity,
  revokeEmployeeSlackIdentity,
} from "@/lib/data/slack-identities";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import {
  isSlackDmChannel,
  looksLikeSlackTs,
  postConversationMessage,
} from "@/lib/gateway/adapters/slack";

const originalFetch = globalThis.fetch;
const savedEnv = {
  slack: process.env.SLACK_BOT_TOKEN,
  conversation: process.env.SLACK_CONVERSATION_BOT_TOKEN,
};

function restoreEnv() {
  if (savedEnv.slack === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = savedEnv.slack;
  if (savedEnv.conversation === undefined) delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  else process.env.SLACK_CONVERSATION_BOT_TOKEN = savedEnv.conversation;
}


afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe("Slack conversation adapter", () => {
  test("looksLikeSlackTs accepts Slack message timestamps only", () => {
    expect(looksLikeSlackTs("1503435956.000247")).toBe(true);
    expect(looksLikeSlackTs("thread-abc")).toBe(false);
    expect(looksLikeSlackTs("")).toBe(false);
  });

  test("isSlackDmChannel identifies DM channels", () => {
    expect(isSlackDmChannel("D0BT659Q8KZ")).toBe(true);
    expect(isSlackDmChannel("D123")).toBe(true);
    expect(isSlackDmChannel("C0BT659Q8KZ")).toBe(false);
    expect(isSlackDmChannel("G123")).toBe(false);
    expect(isSlackDmChannel("")).toBe(false);
    expect(isSlackDmChannel(null)).toBe(false);
    expect(isSlackDmChannel(undefined)).toBe(false);
  });

  test("returns stub when no enabled adapter is configured", async () => {
    const result = await postConversationMessage({
      orgId: "org_no_slack_adapter",
      channel: "C_INTERNAL",
      text: "hello",
    });
    expect(result).toEqual({ ok: true, delivery: "stub" });
  });

  test("posts via chat.postMessage when the adapter is enabled", async () => {
    await upsertConversationAdapter({
      orgId: "org_adapter_test",
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-live" },
    });
    let url = "";
    let payload: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      url = String(input);
      payload = JSON.parse(String(init?.body || "{}"));
      return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1503435956.000247" });
    }) as typeof fetch;

    const result = await postConversationMessage({
      orgId: "org_adapter_test",
      channel: "C_INTERNAL",
      text: "公開FAQの案内",
      threadTs: "1503435900.000111",
      summarize: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.delivery === "slack") {
      expect(result.channel).toBe("C_INTERNAL");
      expect(result.ts).toBe("1503435956.000247");
    }
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(payload.channel).toBe("C_INTERNAL");
    expect(payload.thread_ts).toBe("1503435900.000111");
    expect(String(payload.text)).toContain("【要約のみ】");
    expect(String(payload.text)).toContain("公開FAQの案内");
  });

  test("returns ok:false when Slack API ok is false", async () => {
    await upsertConversationAdapter({
      orgId: "org_adapter_test",
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-live" },
    });
    globalThis.fetch = (async () =>
      Response.json({ ok: false, error: "channel_not_found" })) as typeof fetch;
    const result = await postConversationMessage({
      orgId: "org_adapter_test",
      channel: "C_MISSING",
      text: "hello",
    });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
  });

  test("falls back to enabled notify Slack botToken when conversation adapter is missing", async () => {
    await upsertNotificationChannel({
      orgId: "org_notify_fallback",
      provider: "slack",
      enabled: true,
      label: "承認用Slack",
      config: { channelId: "C_NOTIFY" },
      secrets: { botToken: "xoxb-notify", signingSecret: "signing" },
    });
    let auth = "";
    let payload: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
      payload = JSON.parse(String(init?.body || "{}"));
      return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1503435956.000247" });
    }) as typeof fetch;
    const result = await postConversationMessage({
      orgId: "org_notify_fallback",
      channel: "C_INTERNAL",
      text: "mention-reply",
    });
    expect(result).toEqual({
      ok: true,
      delivery: "slack",
      channel: "C_INTERNAL",
      ts: "1503435956.000247",
    });
    expect(auth).toBe("Bearer xoxb-notify");
    expect(payload.blocks).toBe(undefined);
    await upsertNotificationChannel({
      orgId: "org_notify_fallback",
      provider: "slack",
      enabled: false,
      config: { channelId: "C_NOTIFY" },
      secrets: { botToken: "xoxb-notify", signingSecret: "signing" },
    });
  });

  test("falls back to SLACK_BOT_TOKEN env when no adapter or notify token", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-env";
    let auth = "";
    globalThis.fetch = (async (_input, init) => {
      auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
      return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1503435956.000247" });
    }) as typeof fetch;
    const result = await postConversationMessage({
      orgId: "org_env_fallback",
      channel: "C_INTERNAL",
      text: "hello",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.delivery).toBe("slack");
    expect(auth).toBe("Bearer xoxb-env");
  });

  test("maps Slack not_in_channel to slack_not_in_channel", async () => {
    await upsertConversationAdapter({
      orgId: "org_adapter_test",
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-live" },
    });
    globalThis.fetch = (async () =>
      Response.json({ ok: false, error: "not_in_channel" })) as typeof fetch;
    const result = await postConversationMessage({
      orgId: "org_adapter_test",
      channel: "C_CONNECT",
      text: "hello",
    });
    expect(result).toEqual({ ok: false, error: "slack_not_in_channel" });
  });

  test("user path uses bound OAuth token as Authorization bearer", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");
    const previousAccounts = emp.allowedAccounts;
    const previousPosting = emp.postingAs;
    emp.allowedAccounts = [
      ...(emp.allowedAccounts ?? []),
      { service: "slack", accountId: "U_ANDO" },
    ];
    emp.postingAs = "user";
    await bindEmployeeSlackIdentity({
      employeeId: emp.id,
      orgId: DEMO_ORG.id,
      slackUserId: "U_ANDO",
      slackTeamId: "T_DEMO",
      displayName: "安藤",
      userToken: "xoxp-user",
    });
    let auth = "";
    let payload: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
      payload = JSON.parse(String(init?.body || "{}"));
      return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1503435956.000247" });
    }) as typeof fetch;
    try {
      const result = await postConversationMessage({
        orgId: DEMO_ORG.id,
        employeeId: emp.id,
        postingAs: "user",
        channel: "C_INTERNAL",
        text: "本人として",
      });
      expect(result.ok).toBe(true);
      expect(auth).toBe("Bearer xoxp-user");
      expect(payload.as_user).toBe(undefined);
    } finally {
      emp.allowedAccounts = previousAccounts;
      emp.postingAs = previousPosting;
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
    }
  });

  test("unbound postingAs=user fails closed (not stub)", async () => {
    await revokeEmployeeSlackIdentity({ employeeId: "emp_comm", orgId: DEMO_ORG.id });
    const result = await postConversationMessage({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      postingAs: "user",
      channel: "C_INTERNAL",
      text: "hello",
    });
    expect(result).toEqual({ ok: false, error: "slack_identity_unbound" });
  });

  test("bot path still stubs when no xoxb is configured", async () => {
    const result = await postConversationMessage({
      orgId: "org_bot_stub",
      employeeId: "emp_comm",
      postingAs: "bot",
      channel: "C_INTERNAL",
      text: "hello",
    });
    expect(result).toEqual({ ok: true, delivery: "stub" });
  });

  test("forces bot token for DM channels even when postingAs=user", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-bot-dm" },
    });
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");
    const previousAccounts = emp.allowedAccounts;
    const previousPosting = emp.postingAs;
    emp.allowedAccounts = [
      ...(emp.allowedAccounts ?? []),
      { service: "slack", accountId: "U_DM_USER" },
    ];
    emp.postingAs = "user";
    await bindEmployeeSlackIdentity({
      employeeId: emp.id,
      orgId: DEMO_ORG.id,
      slackUserId: "U_DM_USER",
      slackTeamId: "T_DEMO",
      displayName: "DMユーザー",
      userToken: "xoxp-user-dm",
    });
    let auth = "";
    globalThis.fetch = (async (_input, init) => {
      auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
      return Response.json({ ok: true, channel: "D0BT659Q8KZ", ts: "1503435956.000247" });
    }) as typeof fetch;
    try {
      const result = await postConversationMessage({
        orgId: DEMO_ORG.id,
        employeeId: emp.id,
        postingAs: "user",
        channel: "D0BT659Q8KZ",
        text: "app DM reply",
      });
      expect(result.ok).toBe(true);
      expect(auth).toBe("Bearer xoxb-bot-dm");
    } finally {
      emp.allowedAccounts = previousAccounts;
      emp.postingAs = previousPosting;
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
    }
  });

  test("retries with conversations.open when channel_not_found on DM", async () => {
    await upsertConversationAdapter({
      orgId: "org_retry_open",
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-retry" },
    });
    let callCount = 0;
    const urls: string[] = [];
    const payloads: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input, init) => {
      callCount++;
      urls.push(String(input));
      payloads.push(JSON.parse(String(init?.body || "{}")));
      if (String(input).includes("chat.postMessage") && callCount === 1) {
        return Response.json({ ok: false, error: "channel_not_found" });
      }
      if (String(input).includes("conversations.open")) {
        return Response.json({ ok: true, channel: { id: "D_OPENED" } });
      }
      return Response.json({ ok: true, channel: "D_OPENED", ts: "1503435956.000247" });
    }) as typeof fetch;
    const result = await postConversationMessage({
      orgId: "org_retry_open",
      channel: "D_STALE",
      text: "retry message",
      slackUserId: "U_COUNTERPART",
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.delivery === "slack") {
      expect(result.channel).toBe("D_OPENED");
    }
    expect(callCount).toBe(3);
    expect(urls[0]).toContain("chat.postMessage");
    expect(urls[1]).toContain("conversations.open");
    expect(payloads[1].users).toBe("U_COUNTERPART");
    expect(urls[2]).toContain("chat.postMessage");
    expect(payloads[2].channel).toBe("D_OPENED");
  });

  test("does not retry with conversations.open for non-DM channels", async () => {
    await upsertConversationAdapter({
      orgId: "org_no_retry",
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-no-retry" },
    });
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return Response.json({ ok: false, error: "channel_not_found" });
    }) as typeof fetch;
    const result = await postConversationMessage({
      orgId: "org_no_retry",
      channel: "C_MISSING",
      text: "no retry",
      slackUserId: "U_COUNTERPART",
    });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
    expect(callCount).toBe(1);
  });

  test("does not retry when slackUserId is missing", async () => {
    await upsertConversationAdapter({
      orgId: "org_no_user_id",
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-no-user" },
    });
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return Response.json({ ok: false, error: "channel_not_found" });
    }) as typeof fetch;
    const result = await postConversationMessage({
      orgId: "org_no_user_id",
      channel: "D_MISSING",
      text: "no user id",
    });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
    expect(callCount).toBe(1);
  });
});
