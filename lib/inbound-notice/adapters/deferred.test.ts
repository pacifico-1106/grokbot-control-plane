import { describe, expect, test } from "bun:test";
import { INBOUND_NOTICE_ADAPTERS } from "@/lib/inbound-notice/adapters";

describe("deferred adapters (木村 2026-10-16)", () => {
  test("only ai-concier is registered; voicemail and forwarded email are not wired", () => {
    expect(INBOUND_NOTICE_ADAPTERS.map((a) => a.id)).toEqual(["ai-concier"]);
    expect(INBOUND_NOTICE_ADAPTERS.some((a) => a.source === "voicemail")).toBe(false);
    expect(INBOUND_NOTICE_ADAPTERS.some((a) => a.source === "forwarded_email")).toBe(false);
  });
});
