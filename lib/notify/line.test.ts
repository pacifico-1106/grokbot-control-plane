import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  isAllowedLineSource,
  resolveLineApprovalMessage,
  sendLineReplyMessages,
  verifyLineSignature,
  withLineReplyCollector,
} from "./line";
import { recordNotificationDelivery } from "@/lib/data/notification-channels";
import type { ApprovalRequest } from "@/lib/types";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

const channel: NotificationChannelRuntime = {
  id: "channel-line",
  orgId: "org-a",
  provider: "line",
  label: "LINE",
  enabled: true,
  isDefault: true,
  config: { destinationId: "C-tenant-a", allowedUserIds: ["U-admin"] },
  webhookRef: "line-ref",
  hasCredentials: true,
  webhookPath: "/api/webhooks/line/line-ref",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  secrets: { channelAccessToken: "token", channelSecret: "line-secret" },
};

describe("LINE tenant webhook boundary", () => {
  test("validates the raw-body signature", () => {
    const body = JSON.stringify({ destination: "bot-a", events: [] });
    const signature = createHmac("sha256", "line-secret").update(body).digest("base64");
    expect(verifyLineSignature(channel, body, signature)).toBe(true);
    expect(verifyLineSignature(channel, `${body} `, signature)).toBe(false);
  });

  test("accepts only the configured destination and allowed user", () => {
    expect(isAllowedLineSource(channel, { groupId: "C-tenant-a", userId: "U-admin" })).toBe(true);
    expect(isAllowedLineSource(channel, { groupId: "C-other", userId: "U-admin" })).toBe(false);
    expect(isAllowedLineSource(channel, { groupId: "C-tenant-a", userId: "U-other" })).toBe(false);
  });
});

type Captured = { url: string; body: Record<string, unknown> };
function captureFetch(status = 200): { calls: Captured[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const approval = {
  id: "apr-line-1",
  orgId: "org-a",
  title: "メール送信の承認",
  revisionNote: null,
} as unknown as ApprovalRequest;

describe("LINE resolve follow-up via Reply (G7)", () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  test("without a collector the follow-up is a Push (today's behavior)", async () => {
    await recordNotificationDelivery({ approval, channelId: channel.id, provider: "line" });
    const cap = captureFetch(); restore = cap.restore;
    await resolveLineApprovalMessage(approval, "approved", "line:U-admin", channel);
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].url).toBe("https://api.line.me/v2/bot/message/push");
  });

  test("inside a collector for the same channel the follow-up is held for the Reply", async () => {
    await recordNotificationDelivery({ approval, channelId: channel.id, provider: "line" });
    const cap = captureFetch(); restore = cap.restore;
    const { collected } = await withLineReplyCollector(channel.id, async () => {
      await resolveLineApprovalMessage(approval, "approved", "line:U-admin", channel);
    });
    expect(cap.calls).toHaveLength(0);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toContain("✅ 承認済み");
  });

  test("a collector for another channel does not capture", async () => {
    await recordNotificationDelivery({ approval, channelId: channel.id, provider: "line" });
    const cap = captureFetch(); restore = cap.restore;
    const { collected } = await withLineReplyCollector("channel-other", async () => {
      await resolveLineApprovalMessage(approval, "approved", "line:U-admin", channel);
    });
    expect(collected).toHaveLength(0);
    expect(cap.calls[0].url).toBe("https://api.line.me/v2/bot/message/push");
  });

  test("sendLineReplyMessages sends up to 5 text messages in one Reply", async () => {
    const cap = captureFetch(); restore = cap.restore;
    const res = await sendLineReplyMessages(channel, "reply-token", ["a", "b", "", "c", "d", "e", "f"]);
    expect(res.ok).toBe(true);
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(cap.calls[0].body.replyToken).toBe("reply-token");
    expect((cap.calls[0].body.messages as unknown[]).length).toBe(5);
  });
});
