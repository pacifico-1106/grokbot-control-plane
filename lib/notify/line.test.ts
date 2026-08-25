import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { isAllowedLineSource, verifyLineSignature } from "./line";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

const channel: NotificationChannelRuntime = {
  id: "channel-line",
  orgId: "org-a",
  provider: "line",
  label: "LINE",
  enabled: true,
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
