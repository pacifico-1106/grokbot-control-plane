import { afterEach, describe, expect, test } from "bun:test";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertNotificationChannel } from "@/lib/data/notification-channels";
import {
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
});
