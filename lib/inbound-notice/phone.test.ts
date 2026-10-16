import { describe, expect, test } from "bun:test";
import { hashPhone, last4Digits, maskPhoneForAudit } from "@/lib/inbound-notice/phone";

describe("phone masking", () => {
  test("last4 is digits-only and never the full number", () => {
    expect(last4Digits("000-0000-1111")).toBe("1111");
    expect(last4Digits("+81 00 0000 2222")).toBe("2222");
    expect(last4Digits("123")).toBeNull();
    expect(last4Digits(null)).toBeNull();
    expect(last4Digits("")).toBeNull();
  });

  test("hash is stable, hex, and does not contain the input digits as a substring of the raw number", () => {
    const a = hashPhone("000-0000-1111");
    const b = hashPhone("00000001111");
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).not.toContain("00000001111");
  });

  test("audit mask keeps last4 + hash only", () => {
    const m = maskPhoneForAudit("000-0000-1111");
    expect(m.phoneLast4).toBe("1111");
    expect(m.phoneHash).toMatch(/^sha256:/);
    expect(JSON.stringify(m)).not.toContain("000-0000-1111");
    expect(maskPhoneForAudit(null)).toEqual({ phoneLast4: null, phoneHash: null });
  });
});
