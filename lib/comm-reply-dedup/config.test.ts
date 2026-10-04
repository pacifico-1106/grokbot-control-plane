/**
 * COMM_REPLY_DEDUP_ENABLED defaults OFF; defaults (30 min window, similar mode
 * at 0.6, 24 h approval expiry) and env overrides with safe bounds; the HMAC key
 * is required outside demo mode (production fails closed when it is missing).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isCommReplyDedupEnabled } from "@/lib/feature-flags";
import { COMM_REPLY_DEDUP_DEFAULTS, commReplyDedupSettings, resolveCommReplyDedupKey } from "./config";

const KEYS = [
  "COMM_REPLY_DEDUP_ENABLED", "COMM_REPLY_DEDUP_WINDOW_MINUTES", "COMM_REPLY_DEDUP_MODE",
  "COMM_REPLY_DEDUP_SIMILARITY", "COMM_REPLY_APPROVAL_TTL_MINUTES", "COMM_REPLY_DEDUP_HMAC_KEY",
  "NOTIFICATION_CONFIG_ENCRYPTION_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
];
const backup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});
function productionLike() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture-project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-anon-key-not-real";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-key-not-real";
}

describe("flag and defaults", () => {
  test("flag is OFF unless set", () => {
    delete process.env.COMM_REPLY_DEDUP_ENABLED;
    expect(isCommReplyDedupEnabled()).toBe(false);
    process.env.COMM_REPLY_DEDUP_ENABLED = "true";
    expect(isCommReplyDedupEnabled()).toBe(true);
  });

  test("defaults: 30 min window, similar ≥ 0.6, 20 chars min for similarity, 24 h approval expiry", () => {
    expect(COMM_REPLY_DEDUP_DEFAULTS).toEqual({
      windowMinutes: 30, mode: "similar", similarityThreshold: 0.6, minSimilarityChars: 20, approvalTtlMinutes: 1440,
    });
    for (const k of KEYS.slice(1, 5)) delete process.env[k];
    expect(commReplyDedupSettings()).toEqual(COMM_REPLY_DEDUP_DEFAULTS);
  });

  test("env overrides are bounded; invalid values fall back to defaults", () => {
    process.env.COMM_REPLY_DEDUP_WINDOW_MINUTES = "10";
    process.env.COMM_REPLY_DEDUP_MODE = "exact";
    process.env.COMM_REPLY_DEDUP_SIMILARITY = "0.8";
    process.env.COMM_REPLY_APPROVAL_TTL_MINUTES = "120";
    expect(commReplyDedupSettings()).toMatchObject({ windowMinutes: 10, mode: "exact", similarityThreshold: 0.8, approvalTtlMinutes: 120 });
    process.env.COMM_REPLY_DEDUP_WINDOW_MINUTES = "-5";
    process.env.COMM_REPLY_DEDUP_MODE = "fuzzy";
    process.env.COMM_REPLY_DEDUP_SIMILARITY = "0.1"; // too loose → default
    process.env.COMM_REPLY_APPROVAL_TTL_MINUTES = "abc";
    expect(commReplyDedupSettings()).toEqual(COMM_REPLY_DEDUP_DEFAULTS);
    process.env.COMM_REPLY_DEDUP_WINDOW_MINUTES = "999999";
    expect(commReplyDedupSettings().windowMinutes).toBe(1440);
  });
});

describe("HMAC key", () => {
  test("demo mode has a fixed dev key", () => {
    expect(Buffer.isBuffer(resolveCommReplyDedupKey())).toBe(true);
  });

  test("production: explicit key (≥ 32 chars) wins; else derived from the notification key; else null (fail closed)", () => {
    productionLike();
    delete process.env.COMM_REPLY_DEDUP_HMAC_KEY;
    delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
    expect(resolveCommReplyDedupKey()).toBeNull();
    process.env.COMM_REPLY_DEDUP_HMAC_KEY = "too-short";
    expect(resolveCommReplyDedupKey()).toBeNull();
    process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "n".repeat(40);
    const derived = resolveCommReplyDedupKey();
    expect(Buffer.isBuffer(derived)).toBe(true);
    expect(derived?.toString("utf8").includes("n".repeat(40))).toBe(false); // derived, not the raw key
    process.env.COMM_REPLY_DEDUP_HMAC_KEY = "k".repeat(40);
    const explicit = resolveCommReplyDedupKey();
    expect(explicit?.equals(derived!)).toBe(false);
  });
});
