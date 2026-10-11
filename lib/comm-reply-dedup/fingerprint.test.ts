/**
 * Duplicate-reply prevention (COMM_REPLY_DEDUP_ENABLED): body normalization,
 * keyed body hash and keyed MinHash sketch. Only hashes leave this module.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { resolveCommReplyDedupKey } from "./config";
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

describe("incident-shaped re-writes under the keyed sketch (木村: supersede only when similar)", () => {
  // Synthetic stand-ins with the measured shape (normalized length ~90; the two
  // queued versions in one DM had 3-gram Jaccard 0.714 / 0.729). Same fixtures as
  // lib/approvals/comm-reply-supersede.test.ts.
  const Q1 =
    "山田さん、明日10時からの定例会議の資料をカレンダーの予定に添付しました。議題は来期の予算配分と採用計画の2点です。事前にお目通しいただき、ご不明点があればこのDMでお知らせください。";
  const Q2 =
    "山田さん、明日10時からの定例会議の資料をカレンダーの予定に添付しております。議題は来期の予算配分と採用計画の2点です。事前にご確認いただき、ご不明な点があればこのDMでお知らせください。";
  const REPLY =
    "山田さん、明日10時からの定例会議の資料をカレンダーの予定に添付しております。議題は来期の予算配分と採用の2点です。事前にお目通しいただき、ご不明な点があればこちらでお知らせください。";
  const OTHER = "経費精算の締め切りが今週金曜日に変更になりました。領収書の提出がまだの場合は、木曜日までに経理部へ提出をお願いします。";
  const grams = (t: string) => {
    const c = Array.from(normalizeReplyBody(t));
    const g = new Set<string>();
    for (let i = 0; i + 3 <= c.length; i++) g.add(c.slice(i, i + 3).join(""));
    return g;
  };
  const jaccard = (a: string, b: string) => {
    const A = grams(a);
    const B = grams(b);
    let n = 0;
    for (const x of A) if (B.has(x)) n++;
    return n / (A.size + B.size - n);
  };
  const sim = (a: string, b: string, key: Buffer) =>
    sketchSimilarity(fingerprintReplyBody(a, key).sketch, fingerprintReplyBody(b, key).sketch);

  test("fixtures have the incident's shape (Jaccard ≈ 0.71–0.74) and are not exact duplicates", () => {
    expect(jaccard(Q1, Q2)).toBeGreaterThanOrEqual(0.71);
    expect(jaccard(Q1, Q2)).toBeLessThanOrEqual(0.73);
    expect(jaccard(Q2, REPLY)).toBeGreaterThanOrEqual(0.71);
    expect(jaccard(Q2, REPLY)).toBeLessThanOrEqual(0.74);
    expect(fingerprintReplyBody(Q1, KEY).bodyHash).not.toBe(fingerprintReplyBody(Q2, KEY).bodyHash);
  });

  test("similar (≥ 0.6) under the test key and the demo key; another matter is not (< 0.1)", () => {
    const demoKey = resolveCommReplyDedupKey(); // demo mode in tests: the fixed dev key the gateway tests use
    expect(demoKey).not.toBeNull();
    for (const key of [KEY, OTHER_KEY, demoKey!]) {
      expect(sim(Q1, Q2, key)).toBeGreaterThanOrEqual(0.6);
      expect(sim(Q2, REPLY, key)).toBeGreaterThanOrEqual(0.6);
      expect(sim(Q1, OTHER, key)).toBeLessThan(0.1);
    }
  });

  test("across 500 keys: Jaccard ≈ 0.72 re-writes clear 0.6 for ≥ 99% of keys (MinHash spread)", () => {
    let below = 0;
    for (let i = 0; i < 500; i++) {
      const key = createHmac("sha256", "fixture-key-sweep").update(String(i)).digest();
      if (sim(Q1, Q2, key) < 0.6) below++;
      if (sim(Q2, REPLY, key) < 0.6) below++;
    }
    expect(below / 1000).toBeLessThanOrEqual(0.01);
  });
});
