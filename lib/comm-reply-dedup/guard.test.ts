/**
 * Fail closed: flag ON outside demo mode without an HMAC key (neither
 * COMM_REPLY_DEDUP_HMAC_KEY nor NOTIFICATION_CONFIG_ENCRYPTION_KEY) → nothing
 * is sent: invoke gets duplicate_check_unavailable, approval fulfill gets
 * fulfill_blocked_dedup_unavailable. Fixture env only; fetch is stubbed to fail
 * so no network is reached.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  claimDirectCommReplySend,
  FULFILL_BLOCKED_DEDUP_UNAVAILABLE,
  fulfillDedupGate,
  precheckCommReplyDuplicate,
  prepareCommReplyDedupFromBody,
} from "./guard";
import type { ApprovalRequest, GatewayInvokeRequest } from "@/lib/types";
import type { InvokeSnapshot } from "@/lib/approvals/fulfill";

const KEYS = [
  "COMM_REPLY_DEDUP_ENABLED", "COMM_REPLY_DEDUP_HMAC_KEY", "NOTIFICATION_CONFIG_ENCRYPTION_KEY",
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
];
const backup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
afterEach(() => {
  for (const k of KEYS) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
  globalThis.fetch = originalFetch;
});
function productionWithoutKey() {
  process.env.COMM_REPLY_DEDUP_ENABLED = "true";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture-project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-anon-key-not-real";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-key-not-real";
  delete process.env.COMM_REPLY_DEDUP_HMAC_KEY;
  delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  globalThis.fetch = (async () => {
    throw new Error("network disabled in test");
  }) as unknown as typeof fetch;
}

const ORG = "00000000-0000-4000-8000-0000000000a1";
const EMP = "00000000-0000-4000-8000-0000000000b1";
const body = {
  tool: "comm.reply",
  purpose: "comm.internal",
  jobId: "job_fail_closed",
  conversation: { surface: "slack", orgId: ORG, slackChannelId: "D0FAILCLOSED" },
  args: { text: "fixture reply body for fail-closed test" },
} as unknown as GatewayInvokeRequest;

describe("fail closed without an HMAC key (production)", () => {
  test("invoke: prepared = unavailable; pre-check and claim report unavailable", async () => {
    productionWithoutKey();
    const prepared = prepareCommReplyDedupFromBody({ orgId: ORG, employeeId: EMP, body, text: "x" });
    expect(prepared).toEqual({ kind: "unavailable", reason: "dedup_key_missing" });
    expect((await precheckCommReplyDuplicate(prepared)).state).toBe("unavailable");
    expect((await claimDirectCommReplySend(prepared, "comm.reply")).state).toBe("unavailable");
  });

  test("approval fulfill: blocked, not sent", async () => {
    productionWithoutKey();
    const approval = {
      id: "00000000-0000-4000-8000-0000000000c1", orgId: ORG, employeeId: EMP, credentialId: null,
      title: "t", purpose: "comm.internal", summary: "s", risk: "high", status: "approved", tool: "comm.send",
      jobId: "job_fail_closed", metadata: {}, createdAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null,
    } as unknown as ApprovalRequest;
    const snapshot = {
      tool: "comm.send", purpose: "comm.internal", jobId: "job_fail_closed", employeeId: EMP, orgId: ORG,
      postingAs: "bot", conversation: { surface: "slack", slackChannelId: "D0FAILCLOSED" }, args: { text: "x" },
    } as unknown as InvokeSnapshot;
    expect(await fulfillDedupGate(approval, snapshot, "x")).toEqual({ ok: false, code: FULFILL_BLOCKED_DEDUP_UNAVAILABLE });
  });

  test("flag OFF: nothing is checked (legacy behaviour)", async () => {
    productionWithoutKey();
    delete process.env.COMM_REPLY_DEDUP_ENABLED;
    expect(prepareCommReplyDedupFromBody({ orgId: ORG, employeeId: EMP, body, text: "x" })).toEqual({ kind: "off" });
  });
});
