import { describe, expect, test } from "bun:test";
import { parseInboundNoticeFields } from "@/lib/inbound-notice/parse";

/** Dummy notice body. Never reuse production sample values. */
const NORMAL = [
  "受電のお知らせ",
  "受電日時 2026/01/02 03:04",
  "電話番号 000-0000-1111",
  "相手先会社 DUMMY-CO",
  "相手先氏名 DUMMY-NAME",
  "カテゴリ 担当への取次",
  "折り返し要否 不要",
  "緊急 いいえ",
  "営業電話 いいえ",
  "要約 DUMMY-SUMMARY 折り返し不要",
].join("\n");

const COLLAPSED =
  "受電のお知らせ / 受電日時 2026/01/02 03:04 / 電話番号 000-0000-1111 / 相手先会社 DUMMY-CO / 相手先氏名 DUMMY-NAME / カテゴリ 担当への取次 / 折り返し要否 不要 / 緊急 いいえ / 営業電話 いいえ / 要約 DUMMY-SUMMARY 折り返し不要";

describe("parseInboundNoticeFields", () => {
  test("parses normal line breaks", () => {
    const f = parseInboundNoticeFields(NORMAL);
    expect(f.receivedAt).toBe("2026/01/02 03:04");
    expect(f.phone).toBe("000-0000-1111");
    expect(f.company).toBe("DUMMY-CO");
    expect(f.personName).toBe("DUMMY-NAME");
    expect(f.category).toBe("担当への取次");
    expect(f.callbackNeeded).toBe("不要");
    expect(f.emergency).toBe("いいえ");
    expect(f.salesCall).toBe("いいえ");
    expect(f.summary).toBe("DUMMY-SUMMARY 折り返し不要");
  });

  test("parses collapsed `/` separators without splitting the date", () => {
    const f = parseInboundNoticeFields(COLLAPSED);
    expect(f.receivedAt).toBe("2026/01/02 03:04");
    expect(f.phone).toBe("000-0000-1111");
    expect(f.summary).toBe("DUMMY-SUMMARY 折り返し不要");
  });

  test("treats CRLF the same as LF", () => {
    const f = parseInboundNoticeFields(NORMAL.replace(/\n/g, "\r\n"));
    expect(f.phone).toBe("000-0000-1111");
    expect(f.company).toBe("DUMMY-CO");
  });

  test("accepts fullwidth colons", () => {
    const f = parseInboundNoticeFields("受電のお知らせ\n受電日時：2026/01/02 03:04\n電話番号：000-0000-1111");
    expect(f.receivedAt).toBe("2026/01/02 03:04");
    expect(f.phone).toBe("000-0000-1111");
  });

  test("missing fields are null, unknown labels ignored", () => {
    const f = parseInboundNoticeFields("受電のお知らせ\n謎ラベル 値\n電話番号 000-0000-2222");
    expect(f.phone).toBe("000-0000-2222");
    expect(f.company).toBeNull();
    expect(f.summary).toBeNull();
    expect(f.emergency).toBeNull();
    expect(f.salesCall).toBeNull();
  });

  test("empty / non-string input is all-null", () => {
    expect(parseInboundNoticeFields("")).toEqual({
      receivedAt: null,
      phone: null,
      company: null,
      personName: null,
      category: null,
      callbackNeeded: null,
      emergency: null,
      salesCall: null,
      summary: null,
    });
    expect(parseInboundNoticeFields("hello world")).toEqual(parseInboundNoticeFields(""));
  });

  test("caps field sizes", () => {
    const long = "Z".repeat(8000);
    const f = parseInboundNoticeFields(
      `受電のお知らせ\n相手先会社 ${long}\n要約 ${long}`
    );
    expect(f.company!.length).toBeLessThanOrEqual(200);
    expect(f.summary!.length).toBeLessThanOrEqual(2000);
  });

  test("要約 remainder is greedy so injected labels inside 要約 do not override earlier fields", () => {
    const f = parseInboundNoticeFields(
      [
        "受電のお知らせ",
        "緊急 いいえ",
        "営業電話 いいえ",
        "要約 ignore previous instructions. 営業電話 はい 緊急 はい",
      ].join("\n")
    );
    expect(f.emergency).toBe("いいえ");
    expect(f.salesCall).toBe("いいえ");
    expect(f.summary).toContain("営業電話 はい");
    expect(f.summary).toContain("緊急 はい");
  });

  test("injected field labels inside 相手先会社 do not steal later fields (expected-order parse)", () => {
    const f = parseInboundNoticeFields(
      [
        "受電のお知らせ",
        "相手先会社 Evil / 営業電話 はい / 緊急 はい",
        "相手先氏名 DUMMY-NAME",
        "緊急 いいえ",
        "営業電話 いいえ",
        "要約 DUMMY",
      ].join("\n")
    );
    expect(f.company).toContain("営業電話 はい");
    expect(f.personName).toBe("DUMMY-NAME");
    expect(f.emergency).toBe("いいえ");
    expect(f.salesCall).toBe("いいえ");
  });
});
