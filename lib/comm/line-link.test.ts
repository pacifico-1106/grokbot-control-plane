/**
 * L-7: a link code sent to the employee's own LINE (not the approval OA)
 * proves the sender is a Staffpass member. Reuses #354 redeemLineLinkCode
 * (limits forced ON when LINE conversation is ON). channelId = comm account
 * id; voter binding key is comm_account:<accountId>. Plaintext never stored.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCommAccount, resetDemoCommAccounts, type CommAccount } from "@/lib/comm/accounts";
import { redeemConversationLinkCode } from "@/lib/comm/line-link";
import { getVoterBinding, resetDemoVoterBindings } from "@/lib/approval-workflow/voter-binding";
import { DEMO_MEMBERS, DEMO_ORG } from "@/lib/demo-data";
import { issueLineLinkCode, resetDemoLineLinkCodes } from "@/lib/line/link-code";
import { __setLineLinkCodeGuardBackendForTests } from "@/lib/line/link-code-limits";

const ENV = ["COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED", "NOTIFICATION_CONFIG_ENCRYPTION_KEY", "NEXT_PUBLIC_SUPABASE_URL", "VOTER_BINDING_SECRET", "LINE_LINK_CODE_LIMITS_ENABLED"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const ORG = DEMO_ORG.id;
const EMP = "ec100000-0000-4000-8000-000000000001";
const BOT = "U" + "1".repeat(32);
const USER = "U" + "a".repeat(32);
const MEMBER = DEMO_MEMBERS[0]!.id;

let account: CommAccount;
let audits: unknown[];
const origError = console.error;
const origWarn = console.warn;
const origLog = console.log;

beforeEach(async () => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "k".repeat(40);
  process.env.VOTER_BINDING_SECRET = "v".repeat(48);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.LINE_LINK_CODE_LIMITS_ENABLED; // conversation flag forces limits ON
  resetDemoCommAccounts();
  resetDemoLineLinkCodes();
  resetDemoVoterBindings();
  const r = await createCommAccount({ orgId: ORG, employeeId: EMP, surface: "line", externalAccountId: BOT, createdByMemberId: "m1" });
  if (!r.ok) throw new Error(r.reason);
  account = r.account;
  audits = [];
  console.error = (...a: unknown[]) => { audits.push(a); };
  console.warn = console.error;
  console.log = console.error;
});
afterEach(() => {
  console.error = origError;
  console.warn = origWarn;
  console.log = origLog;
  __setLineLinkCodeGuardBackendForTests(null);
  resetDemoLineLinkCodes();
  resetDemoVoterBindings();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function issueFor(channelId: string) {
  const issued = await issueLineLinkCode({ orgId: ORG, channelId, memberId: MEMBER, issuedByUserId: "user-1" });
  if (!issued.ok) throw new Error(issued.reason);
  return issued;
}

describe("redeemConversationLinkCode", () => {
  test("ordinary text is not a link code (the AI may still be woken)", async () => {
    const r = await redeemConversationLinkCode({ orgId: ORG, accountId: account.id, text: "こんにちは", lineUserId: USER });
    expect(r).toEqual({ handled: false });
  });

  test("a code issued for this comm account binds comm_account:<id>, not the approval OA key", async () => {
    const issued = await issueFor(account.id);
    const r = await redeemConversationLinkCode({
      orgId: ORG,
      accountId: account.id,
      text: issued.display,
      lineUserId: USER,
    });
    expect(r).toEqual({ handled: true, bound: true });
    const bound = await getVoterBinding(ORG, "line", `comm_account:${account.id}`, USER);
    expect(bound?.status).toBe("active");
    expect(bound?.memberId).toBe(MEMBER);
    expect(await getVoterBinding(ORG, "line", account.id, USER)).toBeNull();
  });

  test("a code issued for another channel / account is refused (no silent cross-bind)", async () => {
    const issued = await issueFor("chn-approval-oa");
    const r = await redeemConversationLinkCode({
      orgId: ORG,
      accountId: account.id,
      text: issued.display,
      lineUserId: USER,
    });
    expect(r.handled).toBe(true);
    expect(r).toMatchObject({ bound: false });
    expect(await getVoterBinding(ORG, "line", `comm_account:${account.id}`, USER)).toBeNull();
  });

  test("plaintext code is never stored or logged", async () => {
    const issued = await issueFor(account.id);
    await redeemConversationLinkCode({
      orgId: ORG,
      accountId: account.id,
      text: issued.display,
      lineUserId: USER,
    });
    const dumped = JSON.stringify(audits);
    expect(dumped).not.toContain(issued.code);
    expect(dumped).not.toContain(issued.display);
  });

  test("#354 limits apply (conversation ON forces them): a locked sender is refused even with the right code", async () => {
    const issued = await issueFor(account.id);
    __setLineLinkCodeGuardBackendForTests({
      async reserve() { return { result: "sender_locked", attemptId: null, notify: null }; },
      async release() {},
      async alertOps() {},
      async alertRepeat() {},
    });
    const r = await redeemConversationLinkCode({
      orgId: ORG,
      accountId: account.id,
      text: issued.display,
      lineUserId: USER,
    });
    expect(r).toMatchObject({ handled: true, bound: false, reason: "sender_locked" });
    expect(await getVoterBinding(ORG, "line", `comm_account:${account.id}`, USER)).toBeNull();
  });
});
