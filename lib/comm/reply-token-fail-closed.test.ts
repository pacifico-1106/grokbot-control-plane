/**
 * Recording an unknown LINE send must fail closed. Swallowing the upsert
 * lets a later claim miss and fall through to Push (double-deliver).
 */
import { mock } from "bun:test";

let upsertError: unknown = { message: "db down" };
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => ({
    from: () => ({
      upsert: async () => ({ error: upsertError }),
      insert: async () => ({ error: { code: "57014" } }),
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { recordLineReplyUnknown, wasLineReplyUnknown, __resetLineReplyTokenLedgerForTests } from "@/lib/comm/reply-token-ledger";
import { deliverLineConversation } from "@/lib/comm/line-invoke";

const ORG = "ec000000-0000-4000-8000-000000000016";
const KEY = "0b0a0000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.svc";
  upsertError = { message: "db down" };
  __resetLineReplyTokenLedgerForTests();
});
afterEach(() => {
  __resetLineReplyTokenLedgerForTests();
  delete process.env.LINE_CONVERSATION_ENABLED;
  delete process.env.COMM_ACCOUNTS_ENABLED;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("recordLineReplyUnknown fail-closed", () => {
  test("upsert error → ok:false, not recorded", async () => {
    const r = await recordLineReplyUnknown({ orgId: ORG, retryKey: KEY });
    expect(r).toEqual({ ok: false, reason: "storage_error" });
    expect(await wasLineReplyUnknown({ orgId: ORG, retryKey: KEY })).toBe(false);
  });
});

describe("deliverLineConversation", () => {
  test("when recording unknown fails, result stays unknown (never becomes a retryable not_sent)", async () => {
    const result = await deliverLineConversation(
      {
        token: "spc1.x.y",
        args: {},
        text: "x",
        orgId: ORG,
        employeeId: "ec100000-0000-4000-8000-000000000016",
        externalSendAllowed: true,
        retryId: KEY,
      },
      {
        send: async () => ({
          status: "unknown",
          reason: "line_network_error",
          audience: "external",
          mode: "push",
        }),
      }
    );
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("unknown_record_failed");
  });
});
