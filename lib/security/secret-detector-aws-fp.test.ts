/**
 * Secret detector: aws_secret_key false positives (稲盛 #icebox weekly report,
 * 2026-10-05 10:27 JST: a URL path such as https://www.westjr.co.jp/press/...
 * produced redactedPreview "jp/press***") and the zero-leak response contract.
 *
 * Rules under test (lib/security/secret-detector.ts):
 * - aws_secret_key blocks only with an AKIA/ASIA access key id in the same
 *   payload, or an AWS secret keyword near the value (or in its field path);
 *   plus a boundary on both sides and mixed upper/lower/digit.
 * - Otherwise a bounded mixed 40-char string is only "suspected" (no value).
 * - No characters of a matched value are ever returned (redactedPreview is a constant).
 */
import { describe, expect, test } from "bun:test";
import {
  SECRET_DETECTION_NEXT_STEP_JA,
  SECRET_REDACTED_PREVIEW,
  buildSecretDetectionErrorResponse,
  detectSecretInPayload,
  detectSecretInString,
} from "./secret-detector";

const AWS_EX_ID = "AKIAIOSFODNN7EXAMPLE";
const AWS_EX_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
/** 40 chars, mixed case + digits, no '/', distinctive trigrams. */
const FAKE_SECRET = "q7Vx2Lm9Pw4Rt8Ky3Hn6Bd1Fg5Jc0Ws7Te5Qa8Mz";
const DOCS_ID_44 = "1aBcD3fGhIjK4LmNoP5qRsTuV6wXyZ7AbCdEfG8hIjKl";
const DRIVE_FOLDER_ID = "1OSWr4wyeZPu0GeZ5FXFSGZhlIwv_FaLA";

/** Fails if any 3+ char substring of `secret` appears in `haystack`. */
function expectNoSubstring(haystack: string, secret: string, min = 3) {
  for (let i = 0; i + min <= secret.length; i++) {
    const part = secret.slice(i, i + min);
    if (haystack.includes(part)) {
      throw new Error(`leaked substring ${JSON.stringify(part)} of the secret`);
    }
  }
}

function blocked(payload: unknown) {
  const r = detectSecretInPayload(payload);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected block");
  return r;
}

function passes(payload: unknown) {
  const r = detectSecretInPayload(payload);
  expect(r.ok).toBe(true);
  return r;
}

describe("must NOT be blocked (false positives)", () => {
  test("Google Docs / Drive URLs and bare ids", () => {
    passes({ message: `週報: https://docs.google.com/document/d/${DOCS_ID_44}/edit を参照` });
    passes({ url: `https://docs.google.com/document/d/${DOCS_ID_44}/edit?usp=sharing` });
    passes({ message: `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}` });
    passes({ message: `資料: https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}?usp=drive_link` });
    passes({ message: `ID ${DOCS_ID_44}` });
  });

  test("non-Google host with a long slash path (the westjr.co.jp shape), no AWS context", () => {
    // A 40-char run of [A-Za-z0-9/] right after the host (old detector: "jp/press***").
    const exact40 = "https://www.westjr.co.jp/press/article/2026/Q3Report/KansaiV2X.html";
    passes({ message: `本日のニュース ${exact40} を共有します` });
    passes({ url: exact40 });
    const longPath =
      "https://www.westjr.co.jp/press/article/items/2026/10/05/Kansai/Area/Report/Weekly/Summary2026Q4/Detail/index";
    passes({ message: `参考: ${longPath} です` });
    passes({ message: "www.westjr.co.jp/press/article/2026/Q3Report/KansaiV2X/AbcDef123" });
    // Base64-like 64+ runs that are only long because of '/' path separators.
    passes({
      message:
        "https://example.co.jp/Alpha1Bravo2Charlie3/Delta4Echo5Foxtrot6/Golf7Hotel8India9/Juliet0Kilo1Lima2/Mike3",
    });
  });

  test("SHA-1 / git shas (40 hex)", () => {
    passes({ message: "commit 3f786850e387550fdab836ed7e6dc881de23001b を revert" });
    passes({ sha: "da39a3ee5e6b4b0d3255bfef95601890afd80709" });
    passes({ sha: "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709" });
    const r = detectSecretInPayload({ message: "aws secret rotation: 3f786850e387550fdab836ed7e6dc881de23001b" });
    expect(r.ok).toBe(true);
  });

  test("a standalone bounded mixed 40-char string without AWS context is only 'suspected' (no value)", () => {
    const r = detectSecretInPayload({ args: { message: `token? ${FAKE_SECRET} end` } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suspected).toEqual([{ pattern: "aws_secret_key", fieldPath: "args.message", length: 40 }]);
    expectNoSubstring(JSON.stringify(r), FAKE_SECRET);
  });

  test("boundary: an adjacent _ / - / alnum means it is part of a longer token, not a key", () => {
    passes({ message: `aws_secret_access_key: ${FAKE_SECRET}_v2` });
    passes({ message: `aws_secret_access_key: x-${FAKE_SECRET}` });
    passes({ message: `aws_secret_access_key: ${FAKE_SECRET}9` });
  });

  test("mixed-character requirement: a 40-char run without upper+lower+digit is not a key", () => {
    passes({ message: "aws secret access key = abcdefghijklmnopqrstuvwxyzabcdefghijklmn" });
    passes({ message: "aws secret access key = ABCDEFGHIJ0123456789ABCDEFGHIJ0123456789" });
  });

  test("plain URLs without secrets still pass and return exactly { ok: true }", () => {
    expect(detectSecretInString("https://staffpass.sealith.com/app/setup")).toEqual({ ok: true });
    expect(detectSecretInPayload({ url: "https://www.westjr.co.jp/press/" })).toEqual({ ok: true });
  });
});

describe("must STILL be blocked", () => {
  test("AWS official example pair", () => {
    const r = blocked({ message: `AWS_ACCESS_KEY_ID=${AWS_EX_ID}\nAWS_SECRET_ACCESS_KEY=${AWS_EX_SECRET}` });
    expect(["aws_access_key", "aws_secret_key"]).toContain(r.pattern);
    const onlySecretWithIdElsewhere = blocked({ a: { id: AWS_EX_ID }, b: { value: AWS_EX_SECRET } });
    expect(onlySecretWithIdElsewhere.ok).toBe(false);
  });

  test("(a) secret with an ASIA/AKIA id elsewhere in the same payload", () => {
    const r = detectSecretInString(`creds ${FAKE_SECRET} ok`, { hasAwsAccessKeyId: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.pattern).toBe("aws_secret_key");
    blocked({ first: "ASIAZQ7VX2LM9PW4RT8K", second: FAKE_SECRET });
  });

  test("(b) standalone secret with a keyword nearby (text or field path)", () => {
    expect(blocked({ message: `AWS secret access key は ${FAKE_SECRET} です` }).pattern).toBe("aws_secret_key");
    expect(blocked({ message: `aws_secret_access_key = "${AWS_EX_SECRET}"` }).pattern).toBe("aws_secret_key");
    expect(blocked({ cfg: { SecretAccessKey: FAKE_SECRET } }).pattern).toBe("aws_secret_key");
    expect(blocked({ aws_secret_key: AWS_EX_SECRET }).pattern).toBe("aws_secret_key");
    expect(blocked({ message: `{"SecretAccessKey":"${FAKE_SECRET}"}` }).pattern).toBe("aws_secret_key");
  });

  test("key in a URL query string (raw and percent-encoded, in text and as a bare URL field)", () => {
    const raw = `https://example.com/cb?aws_secret_access_key=${AWS_EX_SECRET}&x=1`;
    const enc = `https://example.com/cb?aws_secret_access_key=${encodeURIComponent(AWS_EX_SECRET)}&x=1`;
    expect(blocked({ url: raw }).pattern).toBe("aws_secret_key");
    expect(blocked({ url: enc }).pattern).toBe("aws_secret_key");
    expect(blocked({ message: `見て ${raw} です` }).pattern).toBe("aws_secret_key");
    expect(blocked({ message: `See https://docs.google.com/document/d/${DOCS_ID_44}/edit?aws_secret_access_key=${FAKE_SECRET}` }).pattern).toBe("aws_secret_key");
    blocked({ url: `https://s3.example.com/obj?AWSAccessKeyId=${AWS_EX_ID}&Signature=abc` });
    // Named patterns are no longer skipped for values that merely start with a URL.
    expect(blocked({ url: "https://example.com/?token=xoxb-123456789012-1234567890123-abcdefghij" }).pattern).toBe("slack_token");
    expect(blocked({ message: "https://example.com/ をどうぞ\nxoxb-123456789012-1234567890123-abcdefghij" }).pattern).toBe("slack_token");
  });

  test("base64 blob ≥64 outside URL paths is still blocked", () => {
    const blob = "QmFzZTY0U2VjcmV0S2V5TWF0ZXJpYWxGb3JUZXN0aW5nT25seU5vdEFSZWFsS2V5QUJDREVGR0g=";
    expect(blocked({ message: `key material: ${blob}` }).pattern).toBe("base64_long_secret");
    expect(blocked({ message: `参照 https://example.com/x?blob=${blob}` }).pattern).toBe("base64_long_secret");
  });
});

describe("other generic patterns: tightened only where real secrets stay blocked", () => {
  test("openai sk-: needs a left boundary (no 'task-' / 'risk-' words)", () => {
    passes({ message: "risk-assessment2026reportQ3final を確認" });
    passes({ jobId: "task-ABCDEFGHIJKLMNOPQRSTUVWX" });
    expect(blocked({ message: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx" }).pattern).toBe("openai_key");
    expect(blocked({ message: "key: sk-abcdefghijklmnopqrstuvwx" }).pattern).toBe("openai_key");
  });

  test("api_key / refresh_token inline: need a separator (identifiers are not secrets)", () => {
    passes({ message: "apiKeyRotationScheduleEnabledV2 を有効化" });
    passes({ message: "refresh_token_rotation_policy_enabled が true" });
    expect(blocked({ message: 'api_key: "abcdefghijklmnopqrstuvwxyz"' }).pattern).toBe("api_key_inline");
    expect(blocked({ message: "api_key=abcdefghijklmnopqrstuvwxyz" }).pattern).toBe("api_key_inline");
    expect(blocked({ message: '"refresh_token":"ya29abcdefghijklmnopqrstuv"' }).pattern).toBe("refresh_token");
    expect(blocked({ message: "refresh_token=ya29abcdefghijklmnopqrstuv" }).pattern).toBe("refresh_token");
  });

  test("aws_access_key: case-sensitive, bounded, ASIA included", () => {
    passes({ message: "akiaiosfodnn7examplexyz は小文字" });
    expect(blocked({ message: `id=${AWS_EX_ID}` }).pattern).toBe("aws_access_key");
    expect(blocked({ message: "id: ASIAZQ7VX2LM9PW4RT8K" }).pattern).toBe("aws_access_key");
  });
});

describe("zero-leak result and response", () => {
  const cases: Array<[string, unknown, string]> = [
    ["aws pair", { message: `AWS_SECRET_ACCESS_KEY=${AWS_EX_SECRET} ${AWS_EX_ID}` }, AWS_EX_SECRET],
    ["aws keyword", { message: `aws secret: ${FAKE_SECRET}` }, FAKE_SECRET],
    // The public prefix (xoxb- / gb_emp_) is the pattern itself; the secret part must not leak.
    ["slack", { args: { message: "t xoxb-123456789012-1234567890123-abcdefghij" } }, "123456789012-1234567890123-abcdefghij"],
    ["staffpass", { secret: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab" }, "1234567890abcdef_abcdef1234567890abcdef1234567890ab"],
  ];
  for (const [name, payload, secret] of cases) {
    test(`${name}: result + response carry pattern / fieldPath / length only`, () => {
      const r = blocked(payload);
      expect(r.redactedPreview).toBe(SECRET_REDACTED_PREVIEW);
      expect(typeof r.fieldPath).toBe("string");
      expect(r.matchLength).toBeGreaterThan(0);
      const resp = buildSecretDetectionErrorResponse(r);
      expectNoSubstring(JSON.stringify(r), secret);
      expectNoSubstring(JSON.stringify(resp), secret);
    });
  }

  test("response adds code / nextStep / retryable and keeps the existing fields", () => {
    const r = blocked({ args: { message: `aws secret: ${FAKE_SECRET}` } });
    const resp = buildSecretDetectionErrorResponse(r);
    expect(resp).toMatchObject({
      ok: false,
      code: "secret_detected_in_payload",
      error: "secret_detected_in_payload",
      pattern: "aws_secret_key",
      redactedPreview: SECRET_REDACTED_PREVIEW,
      nextStep: "該当箇所を外すか伏せて再送してください。誤検知と思われる場合は管理者に連絡してください。",
      retryable: false,
      fieldPath: "args.message",
      matchLength: 40,
    });
    expect(SECRET_DETECTION_NEXT_STEP_JA).toBe(resp.nextStep);
    expect(typeof resp.messageJa).toBe("string");
    expect(typeof resp.nextStepJa).toBe("string");
  });

  test("field paths never echo non-identifier object keys", () => {
    const r = blocked({ ["xoxb-123456789012-1234567890123-zzzzzzzzzz"]: { v: `aws secret: ${FAKE_SECRET}` } });
    expect(r.fieldPath).toBe("[key].v");
    expectNoSubstring(JSON.stringify(r), FAKE_SECRET);
    const arr = blocked({ items: ["ok", { note: `aws secret: ${FAKE_SECRET}` }] });
    expect(arr.fieldPath).toBe("items[1].note");
  });
});
