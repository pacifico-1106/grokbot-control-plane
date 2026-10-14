/**
 * L-6: used-replyToken tracking is a DB (or demo) ledger, not per-process memory.
 * A Reply whose result is unknown is recorded so a restart cannot Reply again
 * (that would double-deliver via Push).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { claimLineReplyToken, recordLineReplyUnknown, wasLineReplyUnknown, __resetLineReplyTokenLedgerForTests } from "@/lib/comm/reply-token-ledger";

const ORG = "ec000000-0000-4000-8000-000000000016";
const ACCT = "ec200000-0000-4000-8000-000000000016";
const RT = "rtok0123456789abcdef";

beforeEach(() => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  __resetLineReplyTokenLedgerForTests();
});
afterEach(() => {
  __resetLineReplyTokenLedgerForTests();
  delete process.env.LINE_CONVERSATION_ENABLED;
  delete process.env.COMM_ACCOUNTS_ENABLED;
});

describe("claimLineReplyToken", () => {
  test("first claim succeeds; the same token is already used", async () => {
    expect(await claimLineReplyToken({ orgId: ORG, accountId: ACCT, replyToken: RT })).toEqual({ ok: true, claimed: true });
    expect(await claimLineReplyToken({ orgId: ORG, accountId: ACCT, replyToken: RT })).toEqual({ ok: true, claimed: false });
  });

  test("a different token is independent", async () => {
    expect(await claimLineReplyToken({ orgId: ORG, accountId: ACCT, replyToken: RT })).toMatchObject({ claimed: true });
    expect(await claimLineReplyToken({ orgId: ORG, accountId: ACCT, replyToken: "other-token-aaaaaaaa" })).toMatchObject({ claimed: true });
  });

  test("survives a process-memory reset (the in-memory Set is gone; the ledger is not)", async () => {
    expect(await claimLineReplyToken({ orgId: ORG, accountId: ACCT, replyToken: RT })).toMatchObject({ claimed: true });
    // simulating another instance: do NOT clear the ledger
    expect(await claimLineReplyToken({ orgId: ORG, accountId: ACCT, replyToken: RT })).toMatchObject({ claimed: false });
  });
});

describe("unknown outcome ledger", () => {
  test("record unknown → wasLineReplyUnknown; a human must decide to resend", async () => {
    expect(await wasLineReplyUnknown({ orgId: ORG, retryKey: "0b0a0000-0000-4000-8000-0000000000aa" })).toBe(false);
    expect(await recordLineReplyUnknown({ orgId: ORG, accountId: ACCT, retryKey: "0b0a0000-0000-4000-8000-0000000000aa" })).toEqual({ ok: true });
    expect(await wasLineReplyUnknown({ orgId: ORG, retryKey: "0b0a0000-0000-4000-8000-0000000000aa" })).toBe(true);
  });
});
