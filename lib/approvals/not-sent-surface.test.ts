/**
 * Kimura 10/14: the H1 reason code is delivery_unsupported_surface.
 * channel_not_supported stays a legacy alias for existing callers.
 */
import { describe, expect, test } from "bun:test";
import {
  CHANNEL_NOT_SUPPORTED,
  DELIVERY_UNSUPPORTED_SURFACE,
  NOT_SENT_DESTINATION_CODES,
  approvalNotSentInfo,
  approvedNotSentInfo,
  channelNotSupportedInfo,
  isUnsupportedSurfaceCode,
} from "@/lib/approvals/not-sent";

describe("delivery_unsupported_surface", () => {
  test("channelNotSupportedInfo emits delivery_unsupported_surface (not the legacy alias)", () => {
    const info = channelNotSupportedInfo("mail");
    expect(info.code).toBe(DELIVERY_UNSUPPORTED_SURFACE);
    expect(info.code).not.toBe(CHANNEL_NOT_SUPPORTED);
    expect(info.sent).toBe(false);
  });

  test("legacy channel_not_supported is still accepted as the same not-sent stop", () => {
    expect(isUnsupportedSurfaceCode(CHANNEL_NOT_SUPPORTED)).toBe(true);
    expect(isUnsupportedSurfaceCode(DELIVERY_UNSUPPORTED_SURFACE)).toBe(true);
    expect(isUnsupportedSurfaceCode("slack_channel_required")).toBe(false);
    expect(NOT_SENT_DESTINATION_CODES.has(CHANNEL_NOT_SUPPORTED)).toBe(true);
    expect(NOT_SENT_DESTINATION_CODES.has(DELIVERY_UNSUPPORTED_SURFACE)).toBe(true);
    const legacy = approvedNotSentInfo(CHANNEL_NOT_SUPPORTED, "telegram");
    expect(legacy.code).toBe(CHANNEL_NOT_SUPPORTED);
    expect(legacy.sent).toBe(false);
    expect(legacy.messageJa).toContain("送信していません");
    const stored = approvalNotSentInfo({
      fulfillment: { ok: false, error: CHANNEL_NOT_SUPPORTED },
      invoke: { conversation: { surface: "mail" } },
    });
    expect(stored?.code).toBe(CHANNEL_NOT_SUPPORTED);
    expect(stored?.sent).toBe(false);
  });
});
