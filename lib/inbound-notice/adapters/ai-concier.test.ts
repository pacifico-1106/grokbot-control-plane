import { describe, expect, test } from "bun:test";
import { aiConcierAdapter } from "@/lib/inbound-notice/adapters/ai-concier";

describe("ai-concier adapter", () => {
  test("id is ai-concier and it claims 受電のお知らせ", () => {
    expect(aiConcierAdapter.id).toBe("ai-concier");
    expect(aiConcierAdapter.source).toBe("ai_concier");
    expect(
      aiConcierAdapter.matches({
        text: "受電のお知らせ / 受電日時 2026/01/02 03:04 / 電話番号 000-0000-1111",
      })
    ).toBe(true);
    expect(aiConcierAdapter.matches({ text: "hello from another bot" })).toBe(false);
  });

  test("parse returns shared intake fields", () => {
    const n = aiConcierAdapter.parse({
      text: "受電のお知らせ\n電話番号 000-0000-1111\n要約 DUMMY",
    });
    expect(n).not.toBeNull();
    expect(n!.adapterId).toBe("ai-concier");
    expect(n!.fields.phone).toBe("000-0000-1111");
    expect(n!.fields.summary).toBe("DUMMY");
  });
});
