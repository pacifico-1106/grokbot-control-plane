/**
 * Where duplicate post guard v2 gets its HMAC key (木村 #278 answers 4,
 * 2026-10-05). Production: COMM_REPLY_DEDUP_ENABLED=true and
 * COMM_REPLY_DEDUP_HMAC_KEY unset. Pinned here:
 *  - v2 has no key of its own: v1 and v2 (conversation, channel and job keys,
 *    sns.publish, file uploads) all use resolveCommReplyDedupKey()
 *  - key unset + NOTIFICATION_CONFIG_ENCRYPTION_KEY (≥ 32) → derived key, v2 ready
 *  - a set-but-short COMM_REPLY_DEDUP_HMAC_KEY is ignored (falls through)
 *  - neither → fail closed on every v2 path (unavailable, nothing is sent)
 *  - switching v2 ON does not change the conversation key (v1 rows still match)
 * Fixture env only, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { prepareCommReplyDedupFromBody, prepareFileUploadDedup, prepareSnsPublishDedup } from "./guard";
import { resolveCommReplyDedupKey } from "./config";
import type { GatewayInvokeRequest } from "@/lib/types";

const KEYS = [
  "COMM_REPLY_DEDUP_ENABLED", "DUPLICATE_GUARD_V2_ENABLED", "COMM_REPLY_DEDUP_HMAC_KEY", "NOTIFICATION_CONFIG_ENCRYPTION_KEY",
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
];
const backup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});
function productionShape(opts: { v2: boolean; notifyKey?: string; dedupKey?: string }) {
  process.env.COMM_REPLY_DEDUP_ENABLED = "true";
  if (opts.v2) process.env.DUPLICATE_GUARD_V2_ENABLED = "true";
  else delete process.env.DUPLICATE_GUARD_V2_ENABLED;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture-project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-anon-key-not-real";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-key-not-real";
  if (opts.dedupKey === undefined) delete process.env.COMM_REPLY_DEDUP_HMAC_KEY;
  else process.env.COMM_REPLY_DEDUP_HMAC_KEY = opts.dedupKey;
  if (opts.notifyKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = opts.notifyKey;
}

const ORG = "00000000-0000-4000-8000-0000000000c1";
const EMP = "00000000-0000-4000-8000-0000000000d1";
const TEXT = "fixture reply body for the hmac key source test, long enough for a sketch";
const body = {
  tool: "comm.reply",
  purpose: "comm.internal",
  jobId: "job_hmac_key_source",
  conversation: { surface: "slack", orgId: ORG, slackChannelId: "C0HMACKEYSRC", threadId: "1791100000.000100" },
  args: { text: TEXT },
} as unknown as GatewayInvokeRequest;
const NOTIFY = "n".repeat(40);

describe("v2 HMAC key source (production shape: dedup key unset)", () => {
  test("notification key present → derived key; every v2 path is ready (no fail-open, no new key needed)", () => {
    productionShape({ v2: true, notifyKey: NOTIFY });
    expect(Buffer.isBuffer(resolveCommReplyDedupKey())).toBe(true);
    const conv = prepareCommReplyDedupFromBody({ orgId: ORG, employeeId: EMP, body, text: TEXT });
    expect(conv.kind).toBe("ready");
    if (conv.kind === "ready") {
      expect(conv.channelKey).toMatch(/^[0-9a-f]{64}$/);
      expect(conv.jobKey).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(prepareSnsPublishDedup({ orgId: ORG, employeeId: EMP, surface: "x", text: TEXT, jobId: "j" }).kind).toBe("ready");
    expect(prepareFileUploadDedup(conv, { fileRef: "ref", filename: "a.pdf", initialComment: "c" }).kind).toBe("ready");
  });

  test("a set-but-short COMM_REPLY_DEDUP_HMAC_KEY is ignored: same key as unset", () => {
    productionShape({ v2: true, notifyKey: NOTIFY });
    const unset = resolveCommReplyDedupKey();
    productionShape({ v2: true, notifyKey: NOTIFY, dedupKey: "short-key" });
    expect(resolveCommReplyDedupKey()?.equals(unset!)).toBe(true);
  });

  test("neither key → fail closed on every v2 path", () => {
    productionShape({ v2: true });
    expect(resolveCommReplyDedupKey()).toBeNull();
    const conv = prepareCommReplyDedupFromBody({ orgId: ORG, employeeId: EMP, body, text: TEXT });
    expect(conv).toEqual({ kind: "unavailable", reason: "dedup_key_missing" });
    expect(prepareSnsPublishDedup({ orgId: ORG, employeeId: EMP, surface: "x", text: TEXT, jobId: "j" })).toEqual({
      kind: "unavailable",
      reason: "dedup_key_missing",
    });
    expect(prepareFileUploadDedup(conv, { fileRef: "ref", filename: "a.pdf" }).kind).toBe("unavailable");
  });

  test("turning v2 ON keeps the same key: the conversation key is unchanged (v1 rows still match)", () => {
    productionShape({ v2: false, notifyKey: NOTIFY });
    const v1 = prepareCommReplyDedupFromBody({ orgId: ORG, employeeId: EMP, body, text: TEXT });
    productionShape({ v2: true, notifyKey: NOTIFY });
    const v2 = prepareCommReplyDedupFromBody({ orgId: ORG, employeeId: EMP, body, text: TEXT });
    expect(v1.kind === "ready" && v2.kind === "ready" && v1.conversationKey === v2.conversationKey).toBe(true);
  });
});
