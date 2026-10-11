/**
 * Production /api/team/members + resolveMemberChangeActor — 木村 decision
 * (PR #263, 3): a session without an active org_members row is 401
 * { error: "auth_required", code: "active_member_required" } (same shape as
 * requireCapability). A member who lacks the permission stays 403.
 * Fixture rows only; Supabase is faked in memory.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { HumanCapability } from "@/lib/types";

type Row = Record<string, unknown>;
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const ALL: HumanCapability[] = [
  "view_dashboard", "view_employees", "view_audit", "approve_actions",
  "manage_spend_limits", "hire_issue_credentials", "manage_team", "manage_billing",
];

const ownerRow = (): Row => ({ id: id(1), org_id: ORG_A, user_id: "u-owner", email: "owner@fixture.invalid", display_name: "owner", role: "owner", job_role: "owner", capabilities: [...ALL], status: "active" });
const adminRow = (): Row => ({ id: id(2), org_id: ORG_A, user_id: "u-admin", email: "admin@fixture.invalid", display_name: "admin", role: "admin", job_role: "custom", capabilities: ["view_dashboard", "manage_team"], status: "active" });
const viewerRow = (): Row => ({ id: id(3), org_id: ORG_A, user_id: "u-viewer", email: "viewer@fixture.invalid", display_name: "viewer", role: "member", job_role: "custom", capabilities: ["view_dashboard"], status: "active" });

let rows: Row[] = [];
let inserts: Row[] = [];
let session: { userId: string | null; email: string | null; orgId: string | null; member: Row | null };

function fakeAdmin() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let mode: "select" | "insert" = "select";
      let payload: Row = {};
      const run = () => {
        if (table !== "org_members") return { data: null, error: null };
        if (mode === "select") return { data: rows.filter((r) => filters.every(([k, v]) => r[k] === v)), error: null };
        inserts.push(payload);
        const row = { status: "invited", user_id: null, ...payload };
        rows.push(row);
        return { data: { ...row }, error: null };
      };
      const q: Record<string, unknown> = {
        select: () => q,
        order: () => q,
        limit: () => q,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        insert: (row: Row) => { mode = "insert"; payload = row; return q; },
        maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        single: async () => run(),
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(run()).then(resolve, reject),
      };
      return q;
    },
  };
}

mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("@/lib/billing/entitlements", () => ({
  assertBillingAllows: async () => ({ ok: true, entitlements: {} }),
}));
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "production",
}));
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => fakeAdmin(),
  createSupabaseBrowserClient: () => null,
  createSupabaseServerClient: () => null,
}));
mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => {
    const { mapMemberRow } = await import("@/lib/data/mappers");
    return {
      demo: false,
      userId: session.userId,
      email: session.email,
      orgId: session.orgId,
      member: session.member ? mapMemberRow(session.member) : null,
    };
  },
  getCurrentOrgId: async () => session.orgId,
}));

const { POST } = await import("./route");
const { resolveMemberChangeActor } = await import("@/lib/team/apply-member-change");

beforeEach(() => {
  rows = [ownerRow(), adminRow(), viewerRow()];
  inserts = [];
  session = { userId: "u-x", email: "x@fixture.invalid", orgId: ORG_A, member: null };
});

const invite = { email: "new@fixture.invalid", displayName: "new", role: "member", jobRole: "custom", capabilities: ["view_dashboard"] };
function post(body: Record<string, unknown>, actorHeader?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (actorHeader) headers["x-member-id"] = actorHeader;
  return POST(new Request(`https://fixture.invalid/api/team/members${actorHeader ? `?as=${actorHeader}` : ""}`, {
    method: "POST", headers, body: JSON.stringify(body),
  }));
}

const NO_ACTIVE_MEMBER: Array<[string, () => typeof session]> = [
  ["signed in, orgId present, no member row", () => ({ userId: "u-x", email: "x@fixture.invalid", orgId: ORG_A, member: null })],
  ["signed in, no org (real getSessionContext shape)", () => ({ userId: "u-x", email: "x@fixture.invalid", orgId: null, member: null })],
  ["no user, orgId present", () => ({ userId: null, email: null, orgId: ORG_A, member: null })],
  ["unauthenticated", () => ({ userId: null, email: null, orgId: null, member: null })],
  ["member row from another org", () => ({ userId: "u-owner", email: "owner@fixture.invalid", orgId: ORG_A, member: { ...ownerRow(), org_id: ORG_B } })],
  ["member row not active", () => ({ userId: "u-owner", email: "owner@fixture.invalid", orgId: ORG_A, member: { ...ownerRow(), status: "disabled" } })],
];

describe("resolveMemberChangeActor: no active member row → 401 auth_required / active_member_required", () => {
  for (const [label, make] of NO_ACTIVE_MEMBER) {
    test(label, async () => {
      session = make();
      const r = await resolveMemberChangeActor(new Request("https://fixture.invalid/", { headers: { "x-member-id": id(1) } }), id(1));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.httpStatus).toBe(401);
      expect(r.error).toBe("auth_required");
      expect(r.code).toBe("active_member_required");
      expect(r.messageJa).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    });
  }

  test("active session member → ok (header / body actor ignored)", async () => {
    session = { userId: "u-viewer", email: "viewer@fixture.invalid", orgId: ORG_A, member: viewerRow() };
    const r = await resolveMemberChangeActor(new Request("https://fixture.invalid/", { headers: { "x-member-id": id(1) } }), id(1));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actor.id).toBe(id(3));
  });
});

describe("POST /api/team/members (production)", () => {
  test("no member row (orgId present) → 401 { error: auth_required, code: active_member_required }, nothing written", async () => {
    const res = await post(invite);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("auth_required");
    expect(body.code).toBe("active_member_required");
    expect(inserts.length).toBe(0);
  });

  test("no member row + x-member-id / ?as= / body actorMemberId naming the owner → 401, nothing written", async () => {
    const res = await post({ ...invite, actorMemberId: id(1) }, id(1));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("auth_required");
    expect(body.code).toBe("active_member_required");
    expect(inserts.length).toBe(0);
  });

  test("unauthenticated → 401 auth_required (requireOrgSession)", async () => {
    session = { userId: null, email: null, orgId: null, member: null };
    const res = await post(invite);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
  });

  test("member without manage_team → 403 manage_team_required (unchanged)", async () => {
    session = { userId: "u-viewer", email: "viewer@fixture.invalid", orgId: ORG_A, member: viewerRow() };
    const res = await post(invite);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("manage_team_required");
    expect(inserts.length).toBe(0);
  });

  test("admin with manage_team → can invite a view-only member", async () => {
    session = { userId: "u-admin", email: "admin@fixture.invalid", orgId: ORG_A, member: adminRow() };
    const res = await post(invite);
    expect(res.status).toBe(200);
    expect(inserts.length).toBe(1);
  });

  test("real owner (member row, role owner) → can invite", async () => {
    session = { userId: "u-owner", email: "owner@fixture.invalid", orgId: ORG_A, member: ownerRow() };
    const res = await post({ ...invite, capabilities: ["view_dashboard", "approve_actions"] });
    expect(res.status).toBe(200);
    expect(inserts.length).toBe(1);
  });
});
