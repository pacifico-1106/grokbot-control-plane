import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hashPhone, last4Digits, maskPhoneForAudit } from "@/lib/inbound-notice/phone";
import { PhoneHashKeyMissingError } from "@/lib/inbound-notice/phone-hash-key";

const KEY = "INBOUND_CALL_NOTICE_PHONE_HASH_KEY";
const FIXTURE = "test-inbound-phone-hash-key-0123456789";
const saved = process.env[KEY];

beforeEach(() => {
  process.env[KEY] = FIXTURE;
});
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe("phone masking", () => {
  test("last4 is digits-only and never the full number", () => {
    expect(last4Digits("000-0000-1111")).toBe("1111");
    expect(last4Digits("+81 00 0000 2222")).toBe("2222");
    expect(last4Digits("123")).toBeNull();
    expect(last4Digits(null)).toBeNull();
    expect(last4Digits("")).toBeNull();
  });

  test("hash is HMAC of digits with the pepper; same digits, different punctuation match", () => {
    const a = hashPhone("000-0000-1111");
    const b = hashPhone("00000001111");
    expect(a).toBe(b);
    expect(a).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(a).not.toContain("00000001111");
  });

  test("different peppers produce different hashes", () => {
    const a = hashPhone("000-0000-1111");
    process.env[KEY] = "another-inbound-phone-hash-key-abcdef";
    expect(hashPhone("000-0000-1111")).not.toBe(a);
  });

  test("missing pepper throws (no unsalted fallback)", () => {
    delete process.env[KEY];
    expect(() => hashPhone("000-0000-1111")).toThrow(PhoneHashKeyMissingError);
  });

  test("audit mask keeps last4 + hmac only", () => {
    const m = maskPhoneForAudit("000-0000-1111");
    expect(m.phoneLast4).toBe("1111");
    expect(m.phoneHash).toMatch(/^hmac-sha256:/);
    expect(JSON.stringify(m)).not.toContain("000-0000-1111");
    expect(maskPhoneForAudit(null)).toEqual({ phoneLast4: null, phoneHash: null });
  });
});
