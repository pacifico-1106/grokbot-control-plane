/**
 * MCP Events (2026-07-28 + Triggers & Events extension) delivery signing:
 * Standard Webhooks profile. Known vector from the Standard Webhooks spec.
 */
import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import {
  parseWhsecSecret,
  signStandardWebhook,
  verifyStandardWebhook,
} from "@/lib/mcp-events/standard-webhooks";

const SPEC_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const SPEC_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const SPEC_TS = 1614265330;
const SPEC_BODY = '{"test": 2432232314}';
const SPEC_SIG = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

describe("whsec_ secret (client supplied, 24–64 bytes)", () => {
  test("accepts the spec vector and 24..64 byte secrets", () => {
    expect(parseWhsecSecret(SPEC_SECRET).ok).toBe(true);
    for (const n of [24, 32, 64]) {
      expect(parseWhsecSecret(`whsec_${randomBytes(n).toString("base64")}`).ok).toBe(true);
    }
  });
  test("rejects missing prefix, short / long keys, non-base64, non-strings", () => {
    for (const bad of [
      undefined, null, 42, "", "whsec_", `whsec_${randomBytes(16).toString("base64")}`,
      `whsec_${randomBytes(65).toString("base64")}`, `sk_${randomBytes(32).toString("base64")}`,
      "whsec_!!!!not-base64!!!!!!!!!!!!!!!!!!!!!!", `whsec_${randomBytes(32).toString("base64")} `,
    ]) {
      expect(parseWhsecSecret(bad).ok).toBe(false);
    }
  });
});

describe("signature = v1,base64(HMAC-SHA256(key, id.ts.body))", () => {
  test("matches the Standard Webhooks spec vector", () => {
    const parsed = parseWhsecSecret(SPEC_SECRET);
    if (!parsed.ok) throw new Error("vector secret rejected");
    expect(signStandardWebhook([parsed.key], SPEC_ID, SPEC_TS, SPEC_BODY)).toBe(SPEC_SIG);
  });
  test("rotation: space-separated signatures, either verifies", () => {
    const a = randomBytes(32), b = randomBytes(32);
    const header = signStandardWebhook([a, b], "evt_x", 1700000000, "{}");
    expect(header.split(" ")).toHaveLength(2);
    for (const key of [a, b]) {
      expect(verifyStandardWebhook(key, { id: "evt_x", timestamp: "1700000000", signature: header }, "{}", { nowSec: 1700000001 })).toBe(true);
    }
    const expected = createHmac("sha256", a).update("evt_x.1700000000.{}").digest("base64");
    expect(header.startsWith(`v1,${expected}`)).toBe(true);
  });
  test("verify rejects a changed body / id, a stale timestamp, and a wrong key", () => {
    const key = randomBytes(32);
    const sig = signStandardWebhook([key], "evt_y", 1700000000, '{"a":1}');
    const h = { id: "evt_y", timestamp: "1700000000", signature: sig };
    expect(verifyStandardWebhook(key, h, '{"a":2}', { nowSec: 1700000000 })).toBe(false);
    expect(verifyStandardWebhook(key, { ...h, id: "evt_z" }, '{"a":1}', { nowSec: 1700000000 })).toBe(false);
    expect(verifyStandardWebhook(key, h, '{"a":1}', { nowSec: 1700000000 + 301 })).toBe(false);
    expect(verifyStandardWebhook(randomBytes(32), h, '{"a":1}', { nowSec: 1700000000 })).toBe(false);
  });
});
