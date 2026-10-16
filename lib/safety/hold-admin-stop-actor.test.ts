/**
 * /admin stop must not stamp ops_console when the super-admin is an active owner
 * of the target org (TOKYO307: owner used 「運営管理」→ opsHold, no 解除を申請).
 * A platform ops who is not that org's owner stays ops_console (S4).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const adminAccess: {
  allowed: boolean;
  reason: "unauthenticated" | "forbidden" | "demo";
  actor: { userId: string; email: string };
} = {
  allowed: true,
  reason: "forbidden",
  actor: { userId: "auth-owner-1", email: "owner@example.com" },
};
mock.module("@/lib/admin/access", () => ({
  getSuperAdminAccess: async () => adminAccess.allowed
    ? { allowed: true as const, actor: adminAccess.actor }
    : { allowed: false as const, reason: adminAccess.reason },
}));

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holdadm";

const { DEMO_ORG, getRuntimeMemberById, setRuntimeMember, resetRuntimeMembers } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const store = await import("@/lib/safety/hold-store");
const notify = await import("@/lib/safety/hold-notify");
const actions = await import("@/lib/safety/hold-actions");
const { writeDesignatedAdminMemberIds } = await import("@/lib/approver-authority/designated-admins");

const ORG = DEMO_ORG.id;
const OWNER_USER = "auth-owner-1";
const OPS_USER = "auth-ops-not-owner";
const web = (memberId: string) => ({
  type: "member" as const,
  member: getRuntimeMemberById(memberId)!,
  surface: "web" as const,
  demoAuthTime: new Date().toISOString(),
});

let saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  saved = { E: process.env.EMPLOYEE_HOLD_ENABLED, O: process.env.ORG_HOLD_ENABLED };
  process.env.EMPLOYEE_HOLD_ENABLED = "true";
  process.env.ORG_HOLD_ENABLED = "true";
  notify.__setHoldNotifierForTests({ tenant: async () => undefined, ops: async () => undefined });
  store.__resetDemoHoldsForTests();
  hold.__setHoldReaderForTests(null);
  resetRuntimeMembers();
  setRuntimeMember({ ...getRuntimeMemberById("mem_1")!, userId: OWNER_USER });
  adminAccess.allowed = true;
  adminAccess.actor = { userId: OWNER_USER, email: "owner@example.com" };
  await writeDesignatedAdminMemberIds(ORG, ["mem_2"]);
});
afterEach(async () => {
  if (saved.E === undefined) delete process.env.EMPLOYEE_HOLD_ENABLED; else process.env.EMPLOYEE_HOLD_ENABLED = saved.E;
  if (saved.O === undefined) delete process.env.ORG_HOLD_ENABLED; else process.env.ORG_HOLD_ENABLED = saved.O;
  notify.__setHoldNotifierForTests(null);
  store.__resetDemoHoldsForTests();
  hold.__setHoldReaderForTests(null);
  resetRuntimeMembers();
  await writeDesignatedAdminMemberIds(ORG, []);
});

describe("actorForAdminStop", () => {
  test("active owner of the target org (same Auth userId) → tenant web, not ops_console", async () => {
    const actor = await actions.actorForAdminStop({ orgId: ORG, opsEmail: "owner@example.com", opsUserId: OWNER_USER });
    expect(actor).toMatchObject({ type: "member", surface: "web" });
    if (actor.type !== "member") return;
    expect(actor.member.id).toBe("mem_1");
    expect(actor.authUserId).toBe(OWNER_USER);
  });
  test("platform ops who is not an owner of this org stays ops_console", async () => {
    const actor = await actions.actorForAdminStop({ orgId: ORG, opsEmail: "ops@staffpass.example", opsUserId: OPS_USER });
    expect(actor).toEqual({ type: "ops", opsId: "ops@staffpass.example", surface: "ops_console" });
  });
  test("matching profile email is not identity — different userId stays ops_console", async () => {
    const actor = await actions.actorForAdminStop({ orgId: ORG, opsEmail: "owner@example.com", opsUserId: "someone-else" });
    expect(actor.type).toBe("ops");
  });
  test("empty userId stays ops_console (fail-closed)", async () => {
    const actor = await actions.actorForAdminStop({ orgId: ORG, opsEmail: "owner@example.com", opsUserId: "  " });
    expect(actor.type).toBe("ops");
  });
});

describe("admin-owner org stop is tenant-releasable; true ops is not", () => {
  test("owner via actorForAdminStop → startedVia web, 解除申請 is accepted", async () => {
    const actor = await actions.actorForAdminStop({ orgId: ORG, opsEmail: "owner@example.com", opsUserId: OWNER_USER });
    const stop = await actions.startHold({ orgId: ORG, employeeId: null, actor });
    expect(stop.ok).toBe(true);
    if (!stop.ok) return;
    const rec = await store.getHoldStore().getHold(ORG, stop.holdId);
    expect(rec?.startedVia).toBe("web");
    expect(rec?.startedBy).toBe("member:mem_1");
    expect(await actions.requestHoldRelease({ orgId: ORG, holdId: stop.holdId, reason: "誤って運営管理から止めた", actor: web("mem_1") })).toMatchObject({ ok: true });
  });
  test("true ops org stop → ops_hold_ops_only on 解除申請", async () => {
    const actor = await actions.actorForAdminStop({ orgId: ORG, opsEmail: "ops@staffpass.example", opsUserId: OPS_USER });
    const stop = await actions.startHold({ orgId: ORG, employeeId: null, actor });
    expect(stop.ok).toBe(true);
    if (!stop.ok) return;
    const rec = await store.getHoldStore().getHold(ORG, stop.holdId);
    expect(rec?.startedVia).toBe("ops_console");
    expect(await actions.requestHoldRelease({ orgId: ORG, holdId: stop.holdId, reason: "x", actor: web("mem_1") })).toMatchObject({ ok: false, code: "ops_hold_ops_only" });
  });
});

describe("POST /api/admin/holds/stop", () => {
  async function post(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/admin/holds/stop/route");
    const res = await POST(new Request("http://localhost/api/admin/holds/stop", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }
  async function orgStatus() {
    const { GET } = await import("@/app/api/holds/status/route");
    const res = await GET(new Request("http://localhost/api/holds/status?scope=org", {
      headers: { "x-member-id": "mem_1" },
    }));
    return await res.json() as { state: string; hold: { opsHold: boolean; startedVia: string } | null };
  }

  test("super-admin owner org stop returns via=web and status opsHold=false", async () => {
    const r = await post({ orgId: ORG, scope: "org" });
    expect(r.status).toBe(200);
    expect(r.body.via).toBe("web");
    const st = await orgStatus();
    expect(st.state).toBe("held");
    expect(st.hold?.startedVia).toBe("web");
    expect(st.hold?.opsHold).toBe(false);
  });
  test("platform ops org stop returns via=ops_console and status opsHold=true", async () => {
    adminAccess.actor = { userId: OPS_USER, email: "ops@staffpass.example" };
    const r = await post({ orgId: ORG, scope: "org" });
    expect(r.status).toBe(200);
    expect(r.body.via).toBe("ops_console");
    const st = await orgStatus();
    expect(st.state).toBe("held");
    expect(st.hold?.startedVia).toBe("ops_console");
    expect(st.hold?.opsHold).toBe(true);
  });
});
