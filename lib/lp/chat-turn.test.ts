import { describe, expect, test } from "bun:test";
import { plainChatText } from "@/lib/lp/chat-turn";

describe("plainChatText (chat bubble is plain text)", () => {
  test("eval 2026-10-02 gpt-4o-mini reply loses Markdown but keeps the words", () => {
    const raw =
      "おすすめのプランは**プロパー**です。\n- **初期費用**: 150,000円（税別）\n- **月額費用**: 150,000円（税別）\n\n\n[プランの詳細を確認する](/lp/ai-employee/checkout?plan=proper)";
    expect(plainChatText(raw)).toBe(
      "おすすめのプランはプロパーです。\n・初期費用: 150,000円（税別）\n・月額費用: 150,000円（税別）\n\nプランの詳細を確認する"
    );
  });
  test("Arabic question mark from gpt-6-luna becomes 全角？; plain text is unchanged", () => {
    expect(plainChatText("まず負担を減らしたい作業はありますか؟")).toBe("まず負担を減らしたい作業はありますか？");
    const plain = "秘書業務なら、予定調整や議事録の下書きから任せられます。どの作業から始めたいですか？";
    expect(plainChatText(plain)).toBe(plain);
  });
  test("headings are stripped", () => {
    expect(plainChatText("## プラン\n本文")).toBe("プラン\n本文");
  });
});
