/**
 * applyMemberChange / resolveMemberChangeActor — production (Supabase) path, faked.
 * Covers: actor from session (never from request headers/body), org-scoped
 * target lookup (IDOR), case-insensitive email → same row, conditional write
 * (TOCTOU), insert-only invites, audit before/after. Fixture data only.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type Row = Record<string, unknown>;
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ALL = ["view_dashboard", "view_employees", "view_audit", "approve_actions", "manage_spend_limits", "hire_issue_credentials", "manage_team", "manage_billing"];

let rows: Row[] = [];
let audits: Row[] = [];
let updates: Array<{ fields: Row; filters: Array<[string, string, unknown]> }> = [];
let inserts: Row[] = [];
let beforeWrite: (() => void) | null = null;
let dbUpdateError: { code?: string; message: string } | null = null;
let session: { userId: string | null; email: string | null; orgId: string | null; member: Row | null } = { userId: null, email: null, orgId: null, member: null };

function matches(row: Row, filters: Array<[string, string, unknown]>) {
  return filters.every(([op, key, value]) => {
    const v = row[key];
    if (op === "eq") return v === value;
    const arr = (v as string[]) ?? [];
    const want = value as string[];
    if (op === "cs") return want.every((x) => arr.includes(x));
    if (op === "cd") return arr.every((x) => want.includes(x));
    return false;
  });
}

function fakeAdmin() {
  return {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      let mode: "select" | "update" | "insert" = "select";
      let payload: Row = {};
      const run = () => {
        if (table === "audit_events") {
          if (mode === "insert") audits.push(payload);
          return { data: null, error: null };
        }
        if (mode === "select") return { data: rows.filter((r) => matches(r, filters)), error: null };
        beforeWrite?.();
        beforeWrite = null;
        if (mode === "update" && dbUpdateError) return { data: null, error: dbUpdateError };
        if (mode === "update") {
          updates.push({ fields: payload, filters: [...filters] });
          const hit = rows.find((r) => matches(r, filters));
          if (!hit) return { data: null, error: null };
          Object.assign(hit, payload);
          return { data: { ...hit }, error: null };
        }
        inserts.push(payload);
        if (rows.some((r) => r.org_id === payload.org_id && r.email === payload.email)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        const row = { status: "invited", user_id: null, ...payload };
        rows.push(row);
        return { data: { ...row }, error: null };
      };
      const q: Record<string, unknown> = {
        select: () => q,
        order: () => q,
        limit: () => q,
        eq: (k: string, v: unknown) => { filters.push(["eq", k, v]); return q; },
        contains: (k: string, v: unknown) => { filters.push(["cs", k, v]); return q; },
        containedBy: (k: string, v: unknown) => { filters.push(["cd", k, v]); return q; },
        update: (fields: Row) => { mode = "update"; payload = fields; return q; },
        insert: (row: Row) => { mode = "insert"; payload = row; return q; },
        maybeSingle: async () => {
          const r = run();
          const data = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
          return { data, error: r.error };
        },
        single: async () => run(),
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(run()).then(resolve, reject),
      };
      return q;
    },
  };
}

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

const { applyMemberChange, resolveMemberChangeActor } = await import("./apply-member-change");
const { mapMemberRow } = await import("@/lib/data/mappers");

const ownerRow = () => ({ id: id(1), org_id: ORG_A, user_id: "u-owner", email: "owner@fixture.invalid", display_name: "owner", role: "owner", job_role: "owner", job_label: null, capabilities: [...ALL], status: "active" });
const adminRow = () => ({ id: id(2), org_id: ORG_A, user_id: "u-admin", email: "admin@fixture.invalid", display_name: "admin", role: "admin", job_role: "custom", job_label: null, capabilities: ["view_dashboard", "manage_team"], status: "active" });
const plainRow = () => ({ id: id(3), org_id: ORG_A, user_id: "u-plain", email: "plain@fixture.invalid", display_name: "plain", role: "member", job_role: "custom", job_label: null, capabilities: ["view_dashboard"], status: "active" });
const otherOrgRow = () => ({ id: id(9), org_id: ORG_B, user_id: "u-b", email: "b@fixture.invalid", display_name: "b", role: "member", job_role: "custom", job_label: null, capabilities: ["view_dashboard"], status: "active" });

const row = (memberId: string) => rows.find((r) => r.id === memberId)!;
const actorOf = (r: Row) => mapMemberRow(r);

beforeEach(() => {
  rows = [ownerRow(), adminRow(), plainRow(), otherOrgRow()];
  audits = [];
  updates = [];
  inserts = [];
  beforeWrite = null;
  dbUpdateError = null;
  session = { userId: null, email: null, orgId: null, member: null };
});

const base = (r: Row) => ({
  orgId: ORG_A,
  targetId: String(r.id),
  email: String(r.email),
  displayName: String(r.display_name),
  role: r.role,
  jobRole: "custom" as const,
  jobLabel: null,
  capabilities: [...(r.capabilities as string[])],
  source: "team_api" as const,
});

describe("resolveMemberChangeActor (production)", () => {
  test("actor comes from the session member; x-member-id / body actor ids are ignored", async () => {
    session = { userId: "u-admin", email: "admin@fixture.invalid", orgId: ORG_A, member: adminRow() };
    const req = new Request("https://fixture.invalid/api/team/members?as=" + id(1), { headers: { "x-member-id": id(1) } });
    const r = await resolveMemberChangeActor(req, id(1));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.id).toBe(id(2));
      expect(r.actor.role).toBe("admin");
      expect(r.authEmail).toBe("admin@fixture.invalid");
    }
  });
  test("no session member → refused (no fallback to org owner)", async () => {
    session = { userId: "u-x", email: "x@fixture.invalid", orgId: ORG_A, member: null };
    const r = await resolveMemberChangeActor(new Request("https://fixture.invalid/", { headers: { "x-member-id": id(1) } }), id(1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("active_member_required");
      expect(r.error).toBe("auth_required");
      expect(r.httpStatus).toBe(401);
    }
  });
});

describe("applyMemberChange (production)", () => {
  test("actor capabilities are re-read from the DB, not trusted from the caller object", async () => {
    // Caller passes a forged actor object claiming owner; the DB row says admin.
    const forged = { ...actorOf(adminRow()), role: "owner" as const, capabilities: ALL as never };
    const r = await applyMemberChange({ ...base(plainRow()), actor: forged, capabilities: ["view_dashboard", "approve_actions"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("owner_required_for_privileged_capability");
    expect(row(id(3)).capabilities).toEqual(["view_dashboard"]);
    expect(updates.length).toBe(0);
  });

  test("target id from another org is not found (IDOR) and nothing is written", async () => {
    const r = await applyMemberChange({ ...base(otherOrgRow()), orgId: ORG_A, actor: actorOf(ownerRow()), capabilities: ["view_dashboard", "approve_actions"] });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe("target_not_found"); expect(r.httpStatus).toBe(404); }
    expect(updates.length + inserts.length).toBe(0);
    expect(row(id(9)).capabilities).toEqual(["view_dashboard"]);
  });

  test("invite to own email with different case resolves to the actor's own row → self escalation", async () => {
    const r = await applyMemberChange({
      orgId: ORG_A, targetId: null, email: "ADMIN@Fixture.Invalid", displayName: "dup", role: "admin",
      jobRole: "custom", jobLabel: null, capabilities: ["view_dashboard", "manage_team", "approve_actions"],
      source: "team_api", actor: actorOf(adminRow()),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("self_escalation_forbidden");
    expect(updates.length + inserts.length).toBe(0);
    expect(audits.at(-1)).toMatchObject({ action: "member.change_denied", org_id: ORG_A, actor_email: "admin@fixture.invalid" });
    expect((audits.at(-1)!.metadata as Row).targetMemberId).toBe(id(2));
  });

  test("invite to the actor's Auth email (second address) is treated as self", async () => {
    const r = await applyMemberChange({
      orgId: ORG_A, targetId: null, email: "admin.login@fixture.invalid", displayName: "alias", role: "member",
      jobRole: "custom", jobLabel: null, capabilities: ["view_dashboard"], source: "team_api",
      actor: actorOf(adminRow()), actorAuthEmail: "Admin.Login@fixture.invalid",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("self_escalation_forbidden");
    expect(inserts.length).toBe(0);
  });

  test("owner change writes conditionally on the values the decision was based on", async () => {
    const r = await applyMemberChange({ ...base(plainRow()), actor: actorOf(ownerRow()), capabilities: ["view_dashboard", "approve_actions"] });
    expect(r.ok).toBe(true);
    expect(updates.length).toBe(1);
    expect(updates[0].filters).toEqual([
      ["eq", "id", id(3)],
      ["eq", "org_id", ORG_A],
      ["eq", "role", "member"],
      ["cs", "capabilities", ["view_dashboard"]],
      ["cd", "capabilities", ["view_dashboard"]],
    ]);
    expect(row(id(3)).capabilities).toEqual(["view_dashboard", "approve_actions"]);
    const a = audits.find((x) => x.action === "member.updated")!;
    expect(a.actor_email).toBe("owner@fixture.invalid");
    expect(a.metadata).toMatchObject({
      memberId: id(3), actorMemberId: id(1), actorUserId: "u-owner", source: "team_api",
      capabilitiesBefore: ["view_dashboard"], capabilitiesAfter: ["view_dashboard", "approve_actions"],
      roleBefore: "member", roleAfter: "member", added: ["approve_actions"], removed: [],
    });
  });

  test("TOCTOU: row changed after the decision → 409, no blind overwrite, denial audited", async () => {
    beforeWrite = () => { row(id(3)).capabilities = ["view_dashboard", "view_audit"]; };
    const r = await applyMemberChange({ ...base(plainRow()), actor: actorOf(ownerRow()), capabilities: ["view_dashboard", "approve_actions"] });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe("concurrent_modification"); expect(r.httpStatus).toBe(409); }
    expect(row(id(3)).capabilities).toEqual(["view_dashboard", "view_audit"]);
    expect(audits.some((x) => x.action === "member.change_denied" && (x.metadata as Row).code === "concurrent_modification")).toBe(true);
  });

  test("TOCTOU: invite whose email appeared concurrently is not turned into an unchecked update", async () => {
    beforeWrite = () => { rows.push({ ...plainRow(), id: id(4), email: "late@fixture.invalid", capabilities: ["view_dashboard"] }); };
    const r = await applyMemberChange({
      orgId: ORG_A, targetId: null, email: "late@fixture.invalid", displayName: "late", role: "member",
      jobRole: "custom", jobLabel: null, capabilities: ["view_dashboard", "view_audit"], source: "team_api",
      actor: actorOf(adminRow()),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("concurrent_modification");
    expect(updates.length).toBe(0);
    expect(row(id(4)).capabilities).toEqual(["view_dashboard"]);
  });

  test("last owner cannot be demoted (owner count is computed from the DB, active owners only)", async () => {
    rows.push({ ...plainRow(), id: id(5), email: "inv-owner@fixture.invalid", user_id: null, role: "owner", status: "invited" });
    const r = await applyMemberChange({ ...base(ownerRow()), actor: actorOf(ownerRow()), role: "admin" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("last_owner_required");
    expect(row(id(1)).role).toBe("owner");
  });

  test("DB last-owner trigger (race backstop) maps to last_owner_required, audited, not a 500", async () => {
    rows.push({ ...ownerRow(), id: id(6), user_id: "u-owner2", email: "owner2@fixture.invalid" });
    dbUpdateError = { code: "23514", message: "last_owner_required" };
    const r = await applyMemberChange({ ...base(row(id(6))), actor: actorOf(ownerRow()), role: "admin" });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe("last_owner_required"); expect(r.httpStatus).toBe(403); }
    expect(audits.some((x) => x.action === "member.change_denied" && (x.metadata as Row).code === "last_owner_required")).toBe(true);
  });

  test("email collision with another member when editing by id → 409", async () => {
    const r = await applyMemberChange({ ...base(plainRow()), email: "OWNER@fixture.invalid", actor: actorOf(ownerRow()) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("email_conflict");
  });
});
