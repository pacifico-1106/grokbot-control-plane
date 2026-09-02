import { describe, expect, test } from "bun:test";
import { parseRolesProposeInput } from "@/lib/mcp/roles-propose";

describe("roles.propose PROCESS SOURCE", () => {
  test("text-only without Drive succeeds", () => {
    const parsed = parseRolesProposeInput({
      sourceType: "text",
      text: "秘書としてメールの下書きと社内Slackの返信をしてほしい",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.sourceType).toBe("text");
    expect(parsed.value.location).toBe("");
    expect(parsed.value.driveWired).toBe(false);
    expect(parsed.value.combinedText).toContain("秘書");
  });

  test("voice transcript without Drive succeeds", () => {
    const parsed = parseRolesProposeInput({
      sourceType: "voice",
      transcript: "営業アシスタントとして見積の下書きをお願いします",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.sourceType).toBe("voice");
    expect(parsed.value.location).toBe("");
    expect(parsed.value.transcript).toContain("見積");
    expect(parsed.value.driveWired).toBe(false);
  });

  test("location-only without document body succeeds (Drive not required)", () => {
    const parsed = parseRolesProposeInput({
      sourceType: "document",
      location: "Drive / 会社オペレーション / 職務.md",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.location).toContain("Drive");
    expect(parsed.value.driveWired).toBe(false);
  });

  test("empty input fails with content_required, not Drive required", () => {
    const parsed = parseRolesProposeInput({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("content_required");
    expect(parsed.driveRequired).toBe(false);
  });

  test("infers voice from transcript alias without sourceType", () => {
    const parsed = parseRolesProposeInput({
      voiceTranscript: "会話ログから事務を雇いたい",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.sourceType).toBe("voice");
  });
});
