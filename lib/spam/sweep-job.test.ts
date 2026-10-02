import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runSpamSweep } from "./sweep-job";
import { createMemorySpamStore, spamOrg } from "./testing";
import type { SpamFacts } from "./score";
import type { ApprovalRequest } from "@/lib/types";

const OPS = "92f3617c-0000-4000-8000-000000000000";
const O1 = "aaaaaaaa-0000-4000-8000-000000000001";
const U1 = "bbbbbbbb-0000-4000-8000-000000000001";
const KEYS = ["CRON_SECRET", "SPAM_SWEEP_ENABLED", "SPAM_ADMIN_TOOLS_ENABLED", "PLATFORM_OPS_ORG_ID", "SIGNUP_ATTEMPT_LOG_ENABLED"];
const backup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => { KEYS.forEach((k) => delete process.env[k]); process.env.CRON_SECRET = "test-cron-secret"; process.env.PLATFORM_OPS_ORG_ID = OPS; });
afterEach(() => KEYS.forEach((k) => (backup[k] === undefined ? delete process.env[k] : (process.env[k] = backup[k]))));

const req = (auth = "Bearer test-cron-secret") => new Request("https://x/api/cron/spam-sweep", { headers: { authorization: auth } });
const now = new Date("2026-10-03T00:00:00Z");
const spamFact: SpamFacts = {
  orgId: O1, orgName: "株式会社サンプル商事", orgCreatedAt: "2026-09-20T00:00:00Z", referralCode: "QWERTYUIOPASDF",
  stripeCustomerId: null, hasStripeSubscription: false, memberCount: 1, employeeCount: 0, sameName24h: 3,
  ownerMemberId: "m1", ownerUserId: U1, ownerMemberStatus: "active", ownerEmail: "spam.bot@gmail.com",
  userCreatedAt: "2026-09-20T00:00:00Z", lastSignInAt: "2026-09-20T00:00:01Z", bannedUntil: null, signupSignals: [], signupIpReuse: 0,
};

function proposeDeps(existing: ApprovalRequest[] = []) {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    deps: {
      listApprovals: async () => existing,
      createApproval: (async (input: Record<string, unknown>) => {
        created.push(input);
        return { approval: { id: `apr_${created.length}`, ...input }, pollUrl: "", statusToken: "", demo: true };
      }) as never,
      notify: async () => null,
      audit: async () => undefined,
    },
  };
}

describe("cron spam-sweep", () => {
  test("auth: no secret 503, wrong bearer 401", async () => {
    delete process.env.CRON_SECRET;
    expect((await runSpamSweep(req())).status).toBe(503);
    process.env.CRON_SECRET = "test-cron-secret";
    expect((await runSpamSweep(req("Bearer nope"))).status).toBe(401);
    expect((await runSpamSweep(req(""))).status).toBe(401);
  });

  test("flag OFF (default) → skipped, store untouched", async () => {
    const store = createMemorySpamStore({ facts: [spamFact] });
    const res = await runSpamSweep(req(), { store, now });
    expect(await res.json()).toEqual({ ok: true, skipped: "flag_off" });
    expect(store.calls).toEqual([]);
  });

  test("sweep ON, admin tools OFF → report only, no proposal, no account writes", async () => {
    process.env.SPAM_SWEEP_ENABLED = "true";
    const store = createMemorySpamStore({ facts: [spamFact], orgs: [spamOrg(O1, U1)] });
    const p = proposeDeps();
    const body = await (await runSpamSweep(req(), { store, now, propose: p.deps })).json();
    expect(body).toMatchObject({ ok: true, candidateCount: 1, proposal: { proposed: false, reason: "spam_admin_tools_disabled" } });
    expect(store.reports.length).toBe(1);
    expect(p.created.length).toBe(0);
    expect(store.calls.some((c) => c.startsWith("ban:") || c.startsWith("members:") || c.startsWith("delete"))).toBe(false);
  });

  test("both ON → one always_human proposal ticket, still no account writes; dedupes pending", async () => {
    process.env.SPAM_SWEEP_ENABLED = "true";
    process.env.SPAM_ADMIN_TOOLS_ENABLED = "true";
    const store = createMemorySpamStore({ facts: [spamFact], orgs: [spamOrg(O1, U1)] });
    const p = proposeDeps();
    const body = await (await runSpamSweep(req(), { store, now, propose: p.deps })).json();
    expect(body.proposal).toMatchObject({ proposed: true, approvalId: "apr_1", orgCount: 1 });
    expect(p.created.length).toBe(1);
    const meta = p.created[0].metadata as Record<string, unknown>;
    expect(meta.always_human).toBe(true);
    expect(meta.adminTool).toBe("accounts.suspend");
    expect((meta.adminRequester as { actorId: string }).actorId).toBe("cron:spam-sweep");
    expect(p.created[0].orgId).toBe(OPS);
    expect(store.reports[0].proposal).toBe("apr_1");
    expect(store.calls.some((c) => c.startsWith("ban:") || c.startsWith("members:"))).toBe(false);

    const pending = { id: "apr_1", status: "pending", tool: "accounts.suspend", metadata: meta } as unknown as ApprovalRequest;
    const p2 = proposeDeps([pending]);
    const body2 = await (await runSpamSweep(req(), { store, now, propose: p2.deps })).json();
    expect(body2.proposal).toMatchObject({ proposed: false, reason: "pending_proposal_exists" });
    expect(p2.created.length).toBe(0);
  });

  test("report never contains full owner email", async () => {
    process.env.SPAM_SWEEP_ENABLED = "true";
    const store = createMemorySpamStore({ facts: [spamFact] });
    let saved = "";
    store.insertReport = async (row) => { saved = JSON.stringify(row.report); return "rep"; };
    await runSpamSweep(req(), { store, now });
    expect(saved).not.toContain("spam.bot@gmail.com");
    expect(saved).toContain("sp***t@gmail.com");
  });
});
