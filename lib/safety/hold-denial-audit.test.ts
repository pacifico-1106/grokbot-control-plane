/**
 * HOLD_DENIAL_AUDIT_ENABLED (default OFF): self_approval_denied → audit_events;
 * MCP org_on_hold / employee_on_hold 403 → mcp_auth_failures (1/min, unique).
 * Audit write failures never change the refusal. Never token / header / secret.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type RpcRes = { data: unknown; error: unknown } | "throw" | "hang";
let rpcRes: RpcRes = { data: true, error: null };
let clientAvailable = true;
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const auditRows: Array<Record<string, unknown>> = [];
let auditThrow = false;

function fakeClient() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (rpcRes === "throw") throw new Error("fetch failed");
      if (rpcRes === "hang") return new Promise(() => {});
      return rpcRes;
    },
  };
}

mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => (clientAvailable ? fakeClient() : null),
}));
mock.module("@/lib/data/audit", () => ({
  appendAuditEvent: async (event: Record<string, unknown>) => {
    if (auditThrow) throw new Error("audit_unavailable");
    auditRows.push(event);
  },
}));

const FLAG = "HOLD_DENIAL_AUDIT_ENABLED";
const saved = {
  flag: process.env[FLAG],
  u: process.env.NEXT_PUBLIC_SUPABASE_URL,
  a: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  s: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
function prodMode() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test-project.supabase.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "unit-test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-service-role-key";
}
afterAll(() => {
  if (saved.flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved.flag;
  for (const [k, v] of [
    ["NEXT_PUBLIC_SUPABASE_URL", saved.u],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", saved.a],
    ["SUPABASE_SERVICE_ROLE_KEY", saved.s],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { isHoldDenialAuditEnabled } = await import("@/lib/feature-flags");
const {
  recordSelfApprovalDenied,
  recordMcpHoldDenied,
  SELF_APPROVAL_DENIED_AUDIT_ACTION,
} = await import("./hold-denial-audit");

const ORG = "aa000000-0000-4000-8000-0000000000a1";
const OTHER = "bb000000-0000-4000-8000-0000000000b1";
const EMP = "aa100000-0000-4000-8000-000000000001";
const HOLD = "aa400000-0000-4000-8000-0000000000a1";
const MEMBER = "aa300000-0000-4000-8000-0000000000m1";
const SECRET = "gb_emp_deadbeefcafebabe_0123456789abcdef0123456789abcdef";
const HASH = "a".repeat(64);

beforeEach(() => {
  rpcCalls.length = 0;
  auditRows.length = 0;
  rpcRes = { data: true, error: null };
  clientAvailable = true;
  auditThrow = false;
  delete process.env[FLAG];
});

describe("HOLD_DENIAL_AUDIT_ENABLED defaults OFF", () => {
  test("unset → OFF; 1 → ON", () => {
    delete process.env[FLAG];
    expect(isHoldDenialAuditEnabled()).toBe(false);
    process.env[FLAG] = "1";
    expect(isHoldDenialAuditEnabled()).toBe(true);
  });
});

describe("recordSelfApprovalDenied", () => {
  test("flag OFF: no audit_events write", async () => {
    prodMode();
    delete process.env[FLAG];
    await recordSelfApprovalDenied({
      orgId: ORG,
      holdId: HOLD,
      employeeId: EMP,
      memberId: MEMBER,
      actorEmail: "admin@example.com",
      requestedBy: `member:${MEMBER}`,
      reason: "self_approval_denied",
    });
    expect(auditRows).toEqual([]);
  });

  test("flag ON: one row with actor, holdId, org, member, reason", async () => {
    prodMode();
    process.env[FLAG] = "1";
    await recordSelfApprovalDenied({
      orgId: ORG,
      holdId: HOLD,
      employeeId: EMP,
      memberId: MEMBER,
      actorEmail: "admin@example.com",
      requestedBy: `member:${MEMBER}`,
      reason: "self_approval_denied",
    });
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0];
    expect(row.orgId).toBe(ORG);
    expect(row.employeeId).toBe(EMP);
    expect(row.action).toBe(SELF_APPROVAL_DENIED_AUDIT_ACTION);
    expect(row.actorEmail).toBe("admin@example.com");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.holdId).toBe(HOLD);
    expect(meta.memberId).toBe(MEMBER);
    expect(meta.actor).toBe(`member:${MEMBER}`);
    expect(meta.reason).toBe("self_approval_denied");
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain("authorization");
    expect(JSON.stringify(row)).not.toContain("x-staffpass-credential");
  });

  test("flag ON: audit throw never reaches the caller", async () => {
    prodMode();
    process.env[FLAG] = "1";
    auditThrow = true;
    await expect(
      recordSelfApprovalDenied({
        orgId: ORG,
        holdId: HOLD,
        memberId: MEMBER,
        reason: "self_approval_denied",
      })
    ).resolves.toBeUndefined();
  });

  test("flag ON: missing orgId does not write (tenant-separated)", async () => {
    prodMode();
    process.env[FLAG] = "1";
    await recordSelfApprovalDenied({
      orgId: "",
      holdId: HOLD,
      memberId: MEMBER,
      reason: "self_approval_denied",
    });
    expect(auditRows).toEqual([]);
  });
});

describe("recordMcpHoldDenied", () => {
  test("flag OFF: no RPC even in production mode", async () => {
    prodMode();
    delete process.env[FLAG];
    await recordMcpHoldDenied({
      kind: "employee_on_hold",
      orgId: ORG,
      employeeId: EMP,
      holdId: HOLD,
      method: "tools/list",
      presentedSecret: SECRET,
    });
    expect(rpcCalls).toEqual([]);
  });

  test("flag ON: records kind + org + employee + holdId + method; never token / hash / header", async () => {
    prodMode();
    process.env[FLAG] = "1";
    await recordMcpHoldDenied({
      kind: "org_on_hold",
      orgId: ORG,
      employeeId: EMP,
      holdId: HOLD,
      credentialId: SECRET,
      method: "tools/call",
      presentedSecret: SECRET,
      fingerprint: HASH,
    } as { kind: string; orgId: string; employeeId: string; holdId: string; credentialId: string; method: string; presentedSecret: string; fingerprint: string });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("record_hold_mcp_denial");
    expect(rpcCalls[0].args).toEqual({
      p_kind: "org_on_hold",
      p_org_id: ORG,
      p_employee_id: EMP,
      p_hold_id: HOLD,
      p_method: "tools/call",
    });
    const dumped = JSON.stringify(rpcCalls);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain(HASH);
    expect(dumped).not.toContain("gb_emp_deadbeef");
    expect(dumped).not.toContain("authorization");
    expect(dumped).not.toContain("x-staffpass-credential");
  });

  test("flag ON: other org is a separate write (tenant-separated)", async () => {
    prodMode();
    process.env[FLAG] = "1";
    await recordMcpHoldDenied({
      kind: "employee_on_hold",
      orgId: ORG,
      employeeId: EMP,
      holdId: HOLD,
      method: "tools/list",
    });
    await recordMcpHoldDenied({
      kind: "employee_on_hold",
      orgId: OTHER,
      employeeId: EMP,
      holdId: HOLD,
      method: "tools/list",
    });
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].args.p_org_id).toBe(ORG);
    expect(rpcCalls[1].args.p_org_id).toBe(OTHER);
  });

  test("flag ON: missing orgId does not write", async () => {
    prodMode();
    process.env[FLAG] = "1";
    await recordMcpHoldDenied({ kind: "employee_on_hold", employeeId: EMP, holdId: HOLD, method: "tools/list" });
    expect(rpcCalls).toEqual([]);
  });

  test("unknown kind / expired / invalid is not written here", async () => {
    prodMode();
    process.env[FLAG] = "1";
    await recordMcpHoldDenied({ kind: "expired", orgId: ORG, employeeId: EMP, method: "tools/list" });
    await recordMcpHoldDenied({ kind: "invalid", orgId: ORG, employeeId: EMP, method: "tools/list" });
    await recordMcpHoldDenied({ kind: "hold_state_unavailable", orgId: ORG, employeeId: EMP, method: "tools/list" });
    expect(rpcCalls).toEqual([]);
  });

  test("rpc throw / no client never throws to the caller", async () => {
    prodMode();
    process.env[FLAG] = "1";
    rpcRes = "throw";
    await expect(
      recordMcpHoldDenied({ kind: "employee_on_hold", orgId: ORG, employeeId: EMP, holdId: HOLD, method: "tools/list" })
    ).resolves.toBeUndefined();
    clientAvailable = false;
    rpcCalls.length = 0;
    await expect(
      recordMcpHoldDenied({ kind: "employee_on_hold", orgId: ORG, employeeId: EMP, holdId: HOLD, method: "tools/list" })
    ).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([]);
  });

  test("hanging RPC times out and never throws", async () => {
    prodMode();
    process.env[FLAG] = "1";
    rpcRes = "hang";
    const started = Date.now();
    await expect(
      recordMcpHoldDenied({ kind: "org_on_hold", orgId: ORG, employeeId: EMP, holdId: HOLD, method: "tools/list" })
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(800);
  });
});
