/**
 * MCP_AUTH_FAILURE_AUDIT_ENABLED (default OFF): /api/mcp auth-failure rows.
 * Never stores the token or its hash. Flag OFF → no RPC.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type RpcRes = { data: unknown; error: unknown } | "throw" | "hang";
let rpcRes: RpcRes = { data: true, error: null };
let clientAvailable = true;
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
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

const FLAG = "MCP_AUTH_FAILURE_AUDIT_ENABLED";
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

const { isMcpAuthFailureAuditEnabled } = await import("@/lib/feature-flags");
const { recordMcpAuthFailure, MCP_AUTH_FAILURE_TIMEOUT_MS } = await import("./mcp-auth-failures");

const ORG = "aa000000-0000-4000-8000-0000000000a1";
const EMP = "aa100000-0000-4000-8000-000000000001";
const CRED = "aa200000-0000-4000-8000-000000000001";
const SECRET = "gb_emp_deadbeefcafebabe_0123456789abcdef0123456789abcdef";
const HASH = "a".repeat(64);

beforeEach(() => {
  rpcCalls.length = 0;
  rpcRes = { data: true, error: null };
  clientAvailable = true;
  delete process.env[FLAG];
});

describe("MCP_AUTH_FAILURE_AUDIT_ENABLED defaults OFF", () => {
  test("unset → OFF; 1 → ON", () => {
    delete process.env[FLAG];
    expect(isMcpAuthFailureAuditEnabled()).toBe(false);
    process.env[FLAG] = "1";
    expect(isMcpAuthFailureAuditEnabled()).toBe(true);
  });
});

describe("recordMcpAuthFailure", () => {
  test("flag OFF: no RPC even in production mode", async () => {
    prodMode();
    delete process.env[FLAG];
    await recordMcpAuthFailure({
      kind: "missing_credential",
      method: "tools/list",
      presentedSecret: SECRET,
    });
    expect(rpcCalls).toEqual([]);
  });

  test("flag ON: records kind + resolvable ids; never token / hash / prefix", async () => {
    prodMode();
    process.env[FLAG] = "1";
    await recordMcpAuthFailure({
      kind: "expired",
      orgId: ORG,
      employeeId: EMP,
      credentialId: CRED,
      method: "tools/call",
      presentedSecret: SECRET,
      fingerprint: HASH,
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("record_mcp_auth_failure");
    const args = rpcCalls[0].args;
    expect(args).toEqual({
      p_kind: "expired",
      p_org_id: ORG,
      p_employee_id: EMP,
      p_credential_id: CRED,
      p_method: "tools/call",
    });
    const dumped = JSON.stringify(rpcCalls);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain(HASH);
    expect(dumped).not.toContain("gb_emp_deadbeef");
    expect(dumped).not.toContain("secret");
    expect(dumped).not.toContain("hash");
  });

  test("flag ON + missing (no identity): still records kind; ids null", async () => {
    prodMode();
    process.env[FLAG] = "1";
    await recordMcpAuthFailure({ kind: "missing_credential", method: "tools/list" });
    expect(rpcCalls[0].args).toMatchObject({
      p_kind: "missing_credential",
      p_org_id: null,
      p_employee_id: null,
      p_credential_id: null,
      p_method: "tools/list",
    });
  });

  test("non-uuid demo ids are dropped (never stored as strings that could be secrets)", async () => {
    prodMode();
    process.env[FLAG] = "1";
    await recordMcpAuthFailure({
      kind: "invalid",
      orgId: "org_demo",
      employeeId: "emp_sales",
      credentialId: SECRET,
      method: "tools/list",
    });
    expect(rpcCalls[0].args.p_org_id).toBeNull();
    expect(rpcCalls[0].args.p_employee_id).toBeNull();
    expect(rpcCalls[0].args.p_credential_id).toBeNull();
    expect(JSON.stringify(rpcCalls)).not.toContain(SECRET);
  });

  test("rpc throw / no client never throws to the caller", async () => {
    prodMode();
    process.env[FLAG] = "1";
    rpcRes = "throw";
    await expect(recordMcpAuthFailure({ kind: "invalid", method: "tools/list" })).resolves.toBeUndefined();
    clientAvailable = false;
    rpcCalls.length = 0;
    await expect(recordMcpAuthFailure({ kind: "invalid", method: "tools/list" })).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([]);
  });

  test("unknown kind is not written", async () => {
    prodMode();
    process.env[FLAG] = "1";
    await recordMcpAuthFailure({ kind: "revoked" as "invalid", method: "tools/list" });
    expect(rpcCalls).toEqual([]);
  });

  test("timeout is bounded so a hung insert cannot stall the 401", () => {
    expect(MCP_AUTH_FAILURE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MCP_AUTH_FAILURE_TIMEOUT_MS).toBeLessThanOrEqual(500);
  });

  test("hanging RPC times out and never throws", async () => {
    prodMode();
    process.env[FLAG] = "1";
    rpcRes = "hang";
    const started = Date.now();
    await expect(recordMcpAuthFailure({ kind: "invalid", method: "tools/list" })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(MCP_AUTH_FAILURE_TIMEOUT_MS + 250);
  }, 1000);
});
