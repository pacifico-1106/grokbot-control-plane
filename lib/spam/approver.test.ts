import { describe, expect, test } from "bun:test";
import { checkSpamApprover, type ApproverAuthUser } from "./approver";
import type { OrgMember } from "@/lib/types";

const OPS = "92f3617c-0000-4000-8000-000000000000";
const YASAKA = "cccccccc-0000-4000-8000-000000000001";
const OTHER = "cccccccc-0000-4000-8000-000000000002";
const env = { PLATFORM_OPS_ORG_ID: OPS, SPAM_ACCOUNTS_APPROVER_USER_IDS: YASAKA } as unknown as NodeJS.ProcessEnv;
const now = new Date("2026-10-03T00:00:00Z");

function member(over: Partial<OrgMember>): OrgMember {
  return { id: "m1", orgId: OPS, email: "boss@example.jp", displayName: "", role: "owner", status: "active", userId: YASAKA, ...over };
}
function deps(members: OrgMember[], users: Record<string, ApproverAuthUser | null>) {
  return {
    listMembers: async () => members,
    getAuthUser: async (id: string) => users[id] ?? null,
    demo: false,
    now,
  };
}
const good: ApproverAuthUser = { id: YASAKA, email: "boss@example.jp", emailConfirmedAt: "2026-01-01T00:00:00Z", bannedUntil: null };
const approval = (over: Record<string, unknown> = {}) => ({ orgId: OPS, resolvedBy: "boss@example.jp", status: "approved" as const, ...over });

describe("checkSpamApprover", () => {
  test("allowlisted active ops member with matching confirmed auth email passes", async () => {
    expect(await checkSpamApprover(approval(), deps([member({})], { [YASAKA]: good }), env)).toEqual({ ok: true, approverUserId: YASAKA });
  });

  test("fails closed when allowlist or ops org is not configured", async () => {
    const d = deps([member({})], { [YASAKA]: good });
    expect(await checkSpamApprover(approval(), d, { PLATFORM_OPS_ORG_ID: OPS } as unknown as NodeJS.ProcessEnv)).toEqual({ ok: false, code: "approver_not_configured" });
    expect(await checkSpamApprover(approval(), d, { SPAM_ACCOUNTS_APPROVER_USER_IDS: YASAKA } as unknown as NodeJS.ProcessEnv)).toEqual({ ok: false, code: "platform_ops_not_configured" });
  });

  test("tickets outside the ops org are refused", async () => {
    expect((await checkSpamApprover(approval({ orgId: "other" }), deps([member({})], { [YASAKA]: good }), env)).ok).toBe(false);
  });

  test("channel actors (slack/telegram/line) never match", async () => {
    for (const r of ["slack:U123", "telegram:42", "line:Uabc", "", null]) {
      const res = await checkSpamApprover(approval({ resolvedBy: r }), deps([member({})], { [YASAKA]: good }), env);
      expect(res).toEqual({ ok: false, code: "approver_channel_not_allowed" });
    }
  });

  test("other ops members are refused even if they approve", async () => {
    const res = await checkSpamApprover(approval({ resolvedBy: "ops2@example.jp" }),
      deps([member({ email: "ops2@example.jp", userId: OTHER })], { [OTHER]: { ...good, id: OTHER, email: "ops2@example.jp" } }), env);
    expect(res).toEqual({ ok: false, code: "approver_not_allowlisted" });
  });

  test("profile email spoof: auth email mismatch / unconfirmed / banned / case duplicates fail closed", async () => {
    expect(await checkSpamApprover(approval(), deps([member({})], { [YASAKA]: { ...good, email: "real@example.jp" } }), env)).toEqual({ ok: false, code: "approver_email_mismatch" });
    expect(await checkSpamApprover(approval(), deps([member({})], { [YASAKA]: { ...good, emailConfirmedAt: null } }), env)).toEqual({ ok: false, code: "approver_email_unconfirmed" });
    expect(await checkSpamApprover(approval(), deps([member({})], { [YASAKA]: { ...good, bannedUntil: "2126-01-01T00:00:00Z" } }), env)).toEqual({ ok: false, code: "approver_banned" });
    expect(await checkSpamApprover(approval(), deps([member({}), member({ id: "m2", email: "BOSS@example.jp", userId: OTHER })], { [YASAKA]: good }), env)).toEqual({ ok: false, code: "approver_ambiguous" });
    expect(await checkSpamApprover(approval(), deps([member({ status: "disabled" })], { [YASAKA]: good }), env)).toEqual({ ok: false, code: "approver_inactive" });
  });

  test("not approved → refused", async () => {
    expect((await checkSpamApprover(approval({ status: "pending" }), deps([member({})], { [YASAKA]: good }), env)).ok).toBe(false);
  });
});
