import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { computePreviewHash, executeSpamPlan, parseSpamActionInput, planSpamAction } from "./accounts";
import { createMemorySpamStore, spamOrg } from "./testing";

const O1 = "aaaaaaaa-0000-4000-8000-000000000001";
const O2 = "aaaaaaaa-0000-4000-8000-000000000002";
const OPS = "92f3617c-0000-4000-8000-000000000000";
const U1 = "bbbbbbbb-0000-4000-8000-000000000001";
const U2 = "bbbbbbbb-0000-4000-8000-000000000002";
const now = new Date("2026-10-03T00:00:00Z");
const ENV_KEYS = ["PLATFORM_OPS_ORG_ID", "SPAM_PROTECTED_ORG_IDS", "SUPER_ADMIN_USER_IDS", "SPAM_ACCOUNTS_APPROVER_USER_IDS"];
const backup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => { ENV_KEYS.forEach((k) => delete process.env[k]); process.env.PLATFORM_OPS_ORG_ID = OPS; });
afterEach(() => ENV_KEYS.forEach((k) => (backup[k] === undefined ? delete process.env[k] : (process.env[k] = backup[k]))));

const input = (action: "suspend" | "unsuspend" | "delete", orgIds: string[]) => ({ action, orgIds, reason: "spam-sample-20261003" });

describe("parseSpamActionInput", () => {
  test("validates ids, count and reason", () => {
    expect(parseSpamActionInput("suspend", { orgIds: [], reason: "xxxx" }).ok).toBe(false);
    expect(parseSpamActionInput("suspend", { orgIds: ["not-a-uuid"], reason: "xxxx" }).ok).toBe(false);
    expect(parseSpamActionInput("suspend", { orgIds: [O1], reason: "x" }).ok).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(parseSpamActionInput("suspend", { orgIds: many, reason: "xxxx" }).ok).toBe(false);
    const ok = parseSpamActionInput("suspend", { orgIds: [O2, O1, O1.toUpperCase()], reason: " spam\nwave " });
    expect(ok.ok && ok.value.orgIds).toEqual([O1, O2]);
    expect(ok.ok && ok.value.reason).toBe("spam wave");
  });
});

describe("planSpamAction", () => {
  test("eligible spam org; hash stable; hash changes with state", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    const a = await planSpamAction(store, input("suspend", [O1]), now);
    const b = await planSpamAction(store, input("suspend", [O1]), now);
    expect(a.eligibleCount).toBe(1);
    expect(a.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.previewHash).toBe(b.previewHash);
    store.orgs[0].members.push({ memberId: "m-new", userId: U2, role: "member", status: "active" });
    store.orgs[0].users.push({ userId: U2, bannedUntil: null, otherOrgIds: [] });
    const c = await planSpamAction(store, input("suspend", [O1]), now);
    expect(c.previewHash).not.toBe(a.previewHash);
  });

  test("protected / billing / employees / other-org users / super admin are refused", async () => {
    process.env.SUPER_ADMIN_USER_IDS = U2;
    const store = createMemorySpamStore({
      orgs: [
        spamOrg(OPS, U1),
        spamOrg(O1, U1, { stripeCustomerId: "cus_1", employeeCount: 1 }),
        spamOrg(O2, U2, { users: [{ userId: U2, bannedUntil: null, otherOrgIds: [OPS] }] }),
      ],
    });
    const plan = await planSpamAction(store, input("suspend", [OPS, O1, O2]), now);
    const by = Object.fromEntries(plan.orgs.map((o) => [o.orgId, o.blockers]));
    expect(by[OPS]).toContain("protected_org");
    for (const b of ["has_billing", "has_ai_employees"]) expect(by[O1]).toContain(b);
    for (const b of ["user_in_other_org", "protected_user"]) expect(by[O2]).toContain(b);
    expect(plan.eligibleCount).toBe(0);
  });

  test("missing org is a blocker", async () => {
    const plan = await planSpamAction(createMemorySpamStore(), input("suspend", [O1]), now);
    expect(plan.orgs[0].blockers).toEqual(["org_not_found"]);
  });

  test("delete: 7-day rule, unsuspend reset, still banned + disabled", async () => {
    const banned = { userId: U1, bannedUntil: "2126-01-01T00:00:00Z", otherOrgIds: [] };
    const disabled = [{ memberId: "m1", userId: U1, role: "owner", status: "disabled" }];
    const mk = (actions: Array<{ action: "suspend" | "unsuspend" | "delete"; createdAt: string }>, over = {}) =>
      createMemorySpamStore({ orgs: [spamOrg(O1, U1, { users: [banned], members: disabled, ...over })], actions: actions.map((a) => ({ orgId: O1, ...a })) });

    expect((await planSpamAction(mk([]), input("delete", [O1]), now)).orgs[0].blockers).toContain("no_suspend_record");
    expect((await planSpamAction(mk([{ action: "suspend", createdAt: "2026-09-27T00:00:01Z" }]), input("delete", [O1]), now)).orgs[0].blockers).toEqual(["suspend_lt_7d"]);
    expect((await planSpamAction(mk([{ action: "suspend", createdAt: "2026-09-26T00:00:00Z" }]), input("delete", [O1]), now)).eligibleCount).toBe(1);
    expect((await planSpamAction(mk([
      { action: "suspend", createdAt: "2026-09-01T00:00:00Z" },
      { action: "unsuspend", createdAt: "2026-09-02T00:00:00Z" },
    ]), input("delete", [O1]), now)).orgs[0].blockers).toContain("unsuspended_after_suspend");
    const notBanned = mk([{ action: "suspend", createdAt: "2026-09-01T00:00:00Z" }], { users: [{ ...banned, bannedUntil: null }], members: [{ ...disabled[0], status: "active" }] });
    const nb = (await planSpamAction(notBanned, input("delete", [O1]), now)).orgs[0].blockers;
    for (const b of ["user_not_banned", "member_not_disabled"]) expect(nb).toContain(b);
  });

  test("unsuspend requires a suspend ledger record", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    expect((await planSpamAction(store, input("unsuspend", [O1]), now)).orgs[0].blockers).toContain("no_suspend_record");
  });
});

describe("executeSpamPlan", () => {
  const ctx = { approvalId: "apr_1", approver: "yasaka-user", requestedBy: "agent", opsOrgId: OPS };

  test("suspend bans before disabling memberships; ledger + audits", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    const plan = await planSpamAction(store, input("suspend", [O1]), now);
    const r = await executeSpamPlan(store, plan, ctx);
    expect(r).toMatchObject({ ok: true, processedOrgs: 1, bannedUsers: 1, membersChanged: 1 });
    const iBan = store.calls.indexOf(`ban:${U1}`);
    const iDis = store.calls.findIndex((c) => c.startsWith("members:active->disabled"));
    expect(iBan).toBeGreaterThan(-1);
    expect(iBan).toBeLessThan(iDis);
    expect(store.actions.map((a) => a.action)).toEqual(["suspend"]);
    expect(store.audits.map((a) => `${a.action}:${a.orgId}`)).toEqual([`admin.spam_suspend:${O1}`, `admin.spam_suspend:${OPS}`]);
    expect(store.orgs[0].members[0].status).toBe("disabled");
  });

  test("refuses to execute when any org is blocked (all-or-nothing)", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1), spamOrg(O2, U2, { stripeCustomerId: "cus_1" })] });
    const plan = await planSpamAction(store, input("suspend", [O1, O2]), now);
    const r = await executeSpamPlan(store, plan, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("ineligible_targets");
    expect(store.calls.some((c) => c.startsWith("ban:"))).toBe(false);
  });

  test("stops on first failure and keeps ledger for completed orgs", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1), spamOrg(O2, U2)] });
    store.failOn = `ban:${U2}`;
    const plan = await planSpamAction(store, input("suspend", [O1, O2]), now);
    const r = await executeSpamPlan(store, plan, ctx);
    expect(r.ok).toBe(false);
    expect(r.failedOrgId).toBe(O2);
    expect(store.actions.map((a) => a.orgId)).toEqual([O1]);
  });

  test("delete removes org then auth users and writes ledger; no target-org audit", async () => {
    const store = createMemorySpamStore({
      orgs: [spamOrg(O1, U1, { users: [{ userId: U1, bannedUntil: "2126-01-01T00:00:00Z", otherOrgIds: [] }], members: [{ memberId: "m1", userId: U1, role: "owner", status: "disabled" }] })],
      actions: [{ orgId: O1, action: "suspend", createdAt: "2026-09-20T00:00:00Z" }],
    });
    const plan = await planSpamAction(store, input("delete", [O1]), now);
    const r = await executeSpamPlan(store, plan, ctx);
    expect(r).toMatchObject({ ok: true, deletedOrgs: 1, deletedUsers: 1 });
    expect(store.calls.indexOf(`deleteOrg:${O1}`)).toBeLessThan(store.calls.indexOf(`deleteUser:${U1}`));
    expect(store.audits.map((a) => a.orgId)).toEqual([OPS]);
  });

  test("hash is order-independent", () => {
    const o = (id: string) => ({ orgId: id, orgName: "", eligible: true, blockers: [], userIds: [], memberIds: [] });
    expect(computePreviewHash("suspend", "r", [o(O1), o(O2)])).toBe(computePreviewHash("suspend", "r", [o(O2), o(O1)]));
    expect(computePreviewHash("suspend", "r", [o(O1)])).not.toBe(computePreviewHash("delete", "r", [o(O1)]));
  });
});
