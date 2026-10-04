/**
 * Duplicate-reply prevention (COMM_REPLY_DEDUP_ENABLED): body normalization,
 * keyed body hash and keyed MinHash sketch. Only hashes leave this module.
 */
import { describe, expect, test } from "bun:test";
import {
  SKETCH_SIZE,
  fingerprintReplyBody,
  normalizeReplyBody,
  sketchSimilarity,
} from "./fingerprint";

const KEY = Buffer.from("test-only-comm-reply-dedup-key-0123456789", "utf8");
const OTHER_KEY = Buffer.from("another-test-only-dedup-key-9876543210", "utf8");

const BASE = "本日15時からの打ち合わせ資料をカレンダーに共有しました。ご確認よろしくお願いします。";
// Same text written differently: full-width digits, half-width kana, spaces, punctuation.
const VARIANT = "本日 １５時から の 打ち合わせ資料を、カレンダーに共有しました！！ ご確認よろしくお願いします…";
// The incident shape: a re-written version of the same message (not byte-equal).
const PARAPHRASE = "本日15時からの打ち合わせ資料をカレンダーで共有しました。お手すきの際にご確認よろしくお願いします。";
const UNRELATED = "来週の経費精算の締め切りは金曜日です。領収書の提出を忘れないようにしてください。";

describe("normalizeReplyBody", () => {
  test("unifies whitespace, punctuation / symbols, width (NFKC) and case", () => {
    expect(normalizeReplyBody(VARIANT)).toBe(normalizeReplyBody(BASE));
    expect(normalizeReplyBody("Ｈｅｌｌｏ,  WORLD!!")).toBe(normalizeReplyBody("hello world"));
    expect(normalizeReplyBody("ｶﾚﾝﾀﾞｰ")).toBe(normalizeReplyBody("カレンダー"));
    expect(normalizeReplyBody(" \n\t ")).toBe("");
  });

  test("Slack link markup keeps the URL, drops the label", () => {
    expect(normalizeReplyBody("見てください <https://example.com/a|こちら>")).toBe(
      normalizeReplyBody("見てください https://example.com/a")
    );
  });
});

describe("fingerprintReplyBody", () => {
  test("body hash is a keyed 64-hex digest, equal for normalized-equal bodies", () => {
    const a = fingerprintReplyBody(BASE, KEY);
    const b = fingerprintReplyBody(VARIANT, KEY);
    expect(a.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.bodyHash).toBe(b.bodyHash);
    expect(fingerprintReplyBody(BASE, OTHER_KEY).bodyHash).not.toBe(a.bodyHash);
    expect(fingerprintReplyBody(UNRELATED, KEY).bodyHash).not.toBe(a.bodyHash);
  });

  test("nothing derived from the text is readable (no substring of the body in the fingerprint)", () => {
    const fp = fingerprintReplyBody(BASE, KEY);
    const json = JSON.stringify(fp);
    for (const piece of ["打ち合わせ", "カレンダー", "15時", "確認"]) {
      expect(json.includes(piece)).toBe(false);
    }
    expect(Object.keys(fp).sort()).toEqual(["bodyHash", "normalizedLength", "sketch"]);
  });

  test("sketch: fixed size of 32-bit integers, deterministic for the same key", () => {
    const fp = fingerprintReplyBody(BASE, KEY);
    expect(fp.sketch?.length).toBe(SKETCH_SIZE);
    expect(fp.sketch?.every((v) => Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31)).toBe(true);
    expect(fingerprintReplyBody(BASE, KEY).sketch).toEqual(fp.sketch);
    expect(fingerprintReplyBody(BASE, OTHER_KEY).sketch).not.toEqual(fp.sketch);
  });

  test("short bodies have no sketch (exact match only)", () => {
    const fp = fingerprintReplyBody("承知しました。", KEY);
    expect(fp.sketch).toBeNull();
    expect(fp.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sketchSimilarity", () => {
  test("identical = 1, re-written version ≥ 0.6, unrelated < 0.3, missing sketch = 0", () => {
    const base = fingerprintReplyBody(BASE, KEY).sketch;
    expect(sketchSimilarity(base, fingerprintReplyBody(VARIANT, KEY).sketch)).toBe(1);
    expect(sketchSimilarity(base, fingerprintReplyBody(PARAPHRASE, KEY).sketch)).toBeGreaterThanOrEqual(0.6);
    expect(sketchSimilarity(base, fingerprintReplyBody(UNRELATED, KEY).sketch)).toBeLessThan(0.3);
    expect(sketchSimilarity(base, null)).toBe(0);
  });
});
