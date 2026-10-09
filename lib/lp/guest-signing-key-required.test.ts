/**
 * GUEST_SIGNING_KEY is required: no dev fallback key (fail closed), same pattern as #294 setup links.
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  formatGuestCookieValue,
  signToken,
  verifySignature,
  generateGuestToken,
} from "@/lib/lp/journeys";
import {
  GUEST_SIGNING_KEY_ENV,
  GuestSigningKeyMissingError,
  isGuestSigningKeyMissingError,
} from "@/lib/lp/guest-signing-key";
import { createHmac } from "node:crypto";

const backup = process.env.GUEST_SIGNING_KEY;
afterAll(() => {
  if (backup === undefined) delete process.env.GUEST_SIGNING_KEY;
  else process.env.GUEST_SIGNING_KEY = backup;
});
beforeEach(() => {
  process.env.GUEST_SIGNING_KEY = "unit-test-signing-key-0123456789";
});

const OLD_DEV_KEY = "dev-fallback-key-not-for-production";
const missingValues: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["blank", "   "],
  ["placeholder", "replace_me_with_random"],
];

describe("GUEST_SIGNING_KEY required (no dev fallback)", () => {
  test("env name is GUEST_SIGNING_KEY", () => {
    expect(GUEST_SIGNING_KEY_ENV).toBe("GUEST_SIGNING_KEY");
  });

  test("journeys.ts source no longer carries a dev fallback key", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/lp/journeys.ts"), "utf8");
    expect(src).not.toContain(OLD_DEV_KEY);
    expect(src).not.toContain("using fallback");
  });

  for (const [label, value] of missingValues) {
    test(`${label} key: signing refuses with GuestSigningKeyMissingError`, () => {
      if (value === undefined) delete process.env.GUEST_SIGNING_KEY;
      else process.env.GUEST_SIGNING_KEY = value;
      const { token } = generateGuestToken();
      let err: unknown;
      try {
        formatGuestCookieValue(token);
      } catch (e) {
        err = e;
      }
      expect(err instanceof GuestSigningKeyMissingError).toBe(true);
      expect(isGuestSigningKeyMissingError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("guest_signing_key_missing");
      expect(() => signToken(token)).toThrow(GuestSigningKeyMissingError);
    });

    test(`${label} key: verifySignature never accepts (refuses with the same error)`, () => {
      if (value === undefined) delete process.env.GUEST_SIGNING_KEY;
      else process.env.GUEST_SIGNING_KEY = value;
      const { token } = generateGuestToken();
      const forged = createHmac("sha256", OLD_DEV_KEY).update(token).digest("hex");
      expect(() => verifySignature(token, forged)).toThrow(GuestSigningKeyMissingError);
    });
  }

  test("configured key: a cookie forged with the old dev key is rejected", () => {
    const { token } = generateGuestToken();
    const forged = createHmac("sha256", OLD_DEV_KEY).update(token).digest("hex");
    expect(verifySignature(token, forged)).toBe(false);
  });

  test("configured key: sign/verify round trip still works", () => {
    const { token } = generateGuestToken();
    const value = formatGuestCookieValue(token);
    const sig = value.slice(value.lastIndexOf(".") + 1);
    expect(verifySignature(token, sig)).toBe(true);
  });

  test("error message names the env var but never contains a key value", () => {
    process.env.GUEST_SIGNING_KEY = "replace_me_secretish";
    try {
      signToken("guest_x");
      throw new Error("expected throw");
    } catch (e) {
      expect(String((e as Error).message)).toContain("GUEST_SIGNING_KEY");
      expect(String((e as Error).message)).not.toContain("replace_me_secretish");
    }
  });

  test("isGuestSigningKeyMissingError is false for other errors", () => {
    expect(isGuestSigningKeyMissingError(new Error("x"))).toBe(false);
    expect(isGuestSigningKeyMissingError(null)).toBe(false);
  });
});
