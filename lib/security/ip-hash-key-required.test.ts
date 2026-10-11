/**
 * IP_HASH_KEY is required (same shape as #302 GUEST_SIGNING_KEY): no "default_hash_key_for_dev"
 * fallback. Missing / blank / placeholder → IpHashKeyMissingError; callers answer 503, no write.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hashIp } from "@/lib/lp/rate-limit";
import { keyedHash } from "@/lib/signup/email-normalize";
import {
  IP_HASH_KEY_ENV,
  IpHashKeyMissingError,
  isIpHashKeyConfigured,
  isIpHashKeyMissingError,
} from "@/lib/security/ip-hash-key";

const backup = process.env.IP_HASH_KEY;
afterAll(() => {
  if (backup === undefined) delete process.env.IP_HASH_KEY;
  else process.env.IP_HASH_KEY = backup;
});
beforeEach(() => {
  process.env.IP_HASH_KEY = "unit-test-ip-hash-key-0123456789";
});

const OLD_DEV_KEY = "default_hash_key_for_dev";
const missing: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["blank", "   "],
  ["placeholder", "replace_me_ip_hash_key"],
  ["old dev default", OLD_DEV_KEY],
];

function setKey(v: string | undefined) {
  if (v === undefined) delete process.env.IP_HASH_KEY;
  else process.env.IP_HASH_KEY = v;
}

describe("IP_HASH_KEY required (no dev fallback)", () => {
  test("env name", () => expect(IP_HASH_KEY_ENV).toBe("IP_HASH_KEY"));

  test("rate-limit.ts and email-normalize.ts no longer carry the dev fallback", () => {
    for (const f of ["lib/lp/rate-limit.ts", "lib/signup/email-normalize.ts"]) {
      expect(readFileSync(path.join(process.cwd(), f), "utf8")).not.toContain(OLD_DEV_KEY);
    }
  });

  for (const [label, value] of missing) {
    test(`${label}: hashIp and keyedHash refuse with IpHashKeyMissingError`, () => {
      setKey(value);
      expect(isIpHashKeyConfigured()).toBe(false);
      for (const fn of [() => hashIp("203.0.113.9"), () => keyedHash("ip:203.0.113.9")]) {
        let err: unknown;
        try {
          fn();
        } catch (e) {
          err = e;
        }
        expect(err instanceof IpHashKeyMissingError).toBe(true);
        expect(isIpHashKeyMissingError(err)).toBe(true);
        expect((err as { code: string }).code).toBe("ip_hash_key_missing");
      }
    });
  }

  test("configured key: hashes work and depend on the key (not the old dev key)", () => {
    expect(isIpHashKeyConfigured()).toBe(true);
    const a = hashIp("203.0.113.9");
    const k = keyedHash("ip:203.0.113.9");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    process.env.IP_HASH_KEY = "another-unit-test-key-abcdef";
    expect(hashIp("203.0.113.9")).not.toBe(a);
  });

  test("error message names the env var, never the value", () => {
    setKey("replace_me_secretish_value");
    try {
      hashIp("1.2.3.4");
      throw new Error("expected throw");
    } catch (e) {
      expect(String((e as Error).message)).toContain("IP_HASH_KEY");
      expect(String((e as Error).message)).not.toContain("replace_me_secretish_value");
    }
  });

  test("isIpHashKeyMissingError is false for other errors", () => {
    expect(isIpHashKeyMissingError(new Error("x"))).toBe(false);
    expect(isIpHashKeyMissingError(undefined)).toBe(false);
  });
});
