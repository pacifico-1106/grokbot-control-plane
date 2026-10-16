/**
 * INBOUND_CALL_NOTICE_PHONE_HASH_KEY follows the IP_HASH_KEY pattern:
 * no fallback. Missing / blank / placeholder → PhoneHashKeyMissingError.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  INBOUND_CALL_NOTICE_PHONE_HASH_KEY_ENV,
  PhoneHashKeyMissingError,
  isPhoneHashKeyConfigured,
  isPhoneHashKeyMissingError,
  requirePhoneHashKey,
} from "@/lib/inbound-notice/phone-hash-key";

const KEY = INBOUND_CALL_NOTICE_PHONE_HASH_KEY_ENV;
const saved = process.env[KEY];
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

const missing: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["blank", "   "],
  ["placeholder", "replace_me_phone_hash_key"],
  ["changeme", "changeme"],
];

function setKey(v: string | undefined) {
  if (v === undefined) delete process.env[KEY];
  else process.env[KEY] = v;
}

describe("INBOUND_CALL_NOTICE_PHONE_HASH_KEY (IP_HASH_KEY pattern)", () => {
  test("env name", () => {
    expect(KEY).toBe("INBOUND_CALL_NOTICE_PHONE_HASH_KEY");
  });

  for (const [label, value] of missing) {
    test(`${label}: refuse, no fallback`, () => {
      setKey(value);
      expect(isPhoneHashKeyConfigured()).toBe(false);
      let err: unknown;
      try {
        requirePhoneHashKey();
      } catch (e) {
        err = e;
      }
      expect(err instanceof PhoneHashKeyMissingError).toBe(true);
      expect(isPhoneHashKeyMissingError(err)).toBe(true);
      expect(String((err as Error).message)).toContain("INBOUND_CALL_NOTICE_PHONE_HASH_KEY");
      expect(String((err as Error).message)).not.toContain("replace_me_phone_hash_key");
    });
  }

  test("configured key is returned as-is", () => {
    setKey("test-inbound-phone-hash-key-0123456789");
    expect(isPhoneHashKeyConfigured()).toBe(true);
    expect(requirePhoneHashKey()).toBe("test-inbound-phone-hash-key-0123456789");
  });
});
