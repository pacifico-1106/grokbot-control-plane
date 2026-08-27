import { afterEach, describe, expect, test } from "bun:test";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import {
  looksLikeSlackTs,
  postConversationMessage,
} from "@/lib/gateway/adapters/slack";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
});
