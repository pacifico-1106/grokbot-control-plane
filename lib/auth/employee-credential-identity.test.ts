/**
 * Auth-failure identity: expired / hash-matched rotated rows resolve
 * org/employee/credential id. Prefix-only guesses must NOT attach identity
 * and must NOT query secret_prefix (timing / existence oracle).
 * Never returns the token or hash on the failure object.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { fingerprintSecret } from "@/lib/bindings";

type Filters = Record<string, unknown>;
type CredRow = {
  id: string;
  org_id: string;
  employee_id: string;
  secret_prefix: string;
  secret_hash: string;
  expires_at: string | null;
  revoked_at: string | null;
};

const ORG = "cc000000-0000-4000-8000-0000000000a1";
const EMP = "cc100000-0000-4000-8000-000000000001";
const CRED = "cc200000-0000-4000-8000-000000000001";
const LIVE = "gb_emp_aabbcc1_0123456789abcdef0123456789ab";
const EXPIRED_SECRET = "gb_emp_expired1_0123456789abcdef0123456789ab";
const ROTATED_OLD = "gb_emp_oldrotat_0123456789abcdef0123456789ab";
const UNKNOWN = "gb_emp_unknown0_0123456789abcdef0123456789ab";
const PREFIX_ONLY = "gb_emp_aabbcc1_ffffffffffffffffffffffffffffffff";

const rows: CredRow[] = [];
const touches: string[] = [];
const prefixEqs: string[] = [];
type Binding = { employeeId: string; orgId: string; status: string; credentialGeneration: number; credentialFingerprint: string };
let bindingByHash: Record<string, Binding | null> = {};
let currentBinding: Binding | null = null;

function matches(row: CredRow, filters: Filters): boolean {
  if (filters.secret_hash && row.secret_hash !== filters.secret_hash) return false;
  if (filters.secret_prefix && row.secret_prefix !== filters.secret_prefix) return false;
  if (filters.employee_id && row.employee_id !== filters.employee_id) return false;
  if (filters.id && row.id !== filters.id) return false;
  if (filters.revoked_at_is === null && row.revoked_at) return false;
  return true;
}

function fakeClient() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "touch_credential_last_used" && typeof args.p_id === "string") touches.push(args.p_id);
      return { data: true, error: null };
    },
    from(table: string) {
      const filters: Filters = {};
      let take = 1;
      const q: Record<string, unknown> = {};
      const run = () => rows.filter((r) => table === "credentials" && matches(r, filters));
      q.select = () => q;
      q.eq = (k: string, v: unknown) => {
        if (k === "secret_prefix") prefixEqs.push(String(v));
        filters[k] = v;
        return q;
      };
      q.is = (k: string, v: unknown) => {
        filters[`${k}_is`] = v;
        return q;
      };
      q.order = () => q;
      q.limit = (n: number) => {
        take = n;
        return q;
      };
      q.maybeSingle = async () => ({ data: run()[0] ?? null, error: null });
      const result = () => Promise.resolve({ data: run().slice(0, take), error: null });
      (q as { then: unknown }).then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => result().then(ok, bad);
      return q;
    },
  };
}

mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => fakeClient() }));
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
mock.module("@/lib/safety/hold", () => ({
  checkOperable: async () => ({ ok: true }),
  preSendHoldCode: async () => null,
}));
mock.module("@/lib/employees/credential-auto-renew-overlap", () => ({
  overlapNewCredentialAllowed: async () => false,
  completeCredentialOverlapOnFirstAuth: async () => false,
}));
mock.module("@/lib/data/credential-renewals", () => ({
  demoGetOverlapCredentialByHash: () => null,
  demoGetOverlapCredential: () => null,
  demoPutOverlapCredential: () => null,
}));
mock.module("@/lib/data", () => ({
  findBindingByCredentialFingerprint: async (hash: string) => bindingByHash[hash] ?? null,
  getBinding: async () => currentBinding ?? undefined,
  getEmployeeById: async (id: string) =>
    id === EMP ? { id: EMP, orgId: ORG, status: "active", displayName: "fixture" } : null,
}));

const saved = {
  u: process.env.NEXT_PUBLIC_SUPABASE_URL,
  a: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  s: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test-project.supabase.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "unit-test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-service-role-key";
afterAll(() => {
  for (const [k, v] of [
    ["NEXT_PUBLIC_SUPABASE_URL", saved.u],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", saved.a],
    ["SUPABASE_SERVICE_ROLE_KEY", saved.s],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { resolveEmployeeCredential } = await import("./employee-credential");

beforeEach(() => {
  rows.length = 0;
  touches.length = 0;
  prefixEqs.length = 0;
  bindingByHash = {};
  currentBinding = null;
  rows.push({
    id: CRED,
    org_id: ORG,
    employee_id: EMP,
    secret_prefix: LIVE.slice(0, 14),
    secret_hash: fingerprintSecret(LIVE),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    revoked_at: null,
  });
});

function req(secret?: string) {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers.authorization = `Bearer ${secret}`;
  return new Request("https://staffpass.test/api/mcp", { headers });
}

describe("prod resolve: identity on 401 + last_used_at on success", () => {
  test("success touches last_used_at with the credential id", async () => {
    bindingByHash[fingerprintSecret(LIVE)] = {
      employeeId: EMP,
      orgId: ORG,
      status: "linked",
      credentialGeneration: 1,
      credentialFingerprint: fingerprintSecret(LIVE),
    };
    const r = await resolveEmployeeCredential(req(LIVE));
    expect(r.ok).toBe(true);
    expect(touches).toEqual([CRED]);
  });

  test("expired attaches org / employee / credential id (no secret)", async () => {
    const hash = fingerprintSecret(EXPIRED_SECRET);
    rows[0].secret_hash = hash;
    rows[0].secret_prefix = EXPIRED_SECRET.slice(0, 14);
    rows[0].expires_at = new Date(Date.now() - 1000).toISOString();
    bindingByHash[hash] = {
      employeeId: EMP,
      orgId: ORG,
      status: "linked",
      credentialGeneration: 1,
      credentialFingerprint: hash,
    };
    const r = await resolveEmployeeCredential(req(EXPIRED_SECRET));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("expired");
    expect(r.orgId).toBe(ORG);
    expect(r.employeeId).toBe(EMP);
    expect(r.credentialId).toBe(CRED);
    expect(touches).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(EXPIRED_SECRET);
    expect(JSON.stringify(r)).not.toContain(hash);
  });

  test("prefix-only token does not attach identity and does not query secret_prefix", async () => {
    const r = await resolveEmployeeCredential(req(PREFIX_ONLY));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("invalid_credential");
    expect(r.orgId).toBeUndefined();
    expect(r.employeeId).toBeUndefined();
    expect(r.credentialId).toBeUndefined();
    expect(prefixEqs).toEqual([]);
    expect(touches).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(PREFIX_ONLY);
    expect(JSON.stringify(r)).not.toContain(LIVE);
  });

  test("unknown token does not query secret_prefix (flags-OFF timing unchanged)", async () => {
    const r = await resolveEmployeeCredential(req(UNKNOWN));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("invalid_credential");
    expect(prefixEqs).toEqual([]);
  });

  test("invalid unknown token does not claim an identity", async () => {
    const r = await resolveEmployeeCredential(req(UNKNOWN));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("invalid_credential");
    expect(r.orgId).toBeUndefined();
    expect(r.employeeId).toBeUndefined();
    expect(r.credentialId).toBeUndefined();
  });

  test("rotated-away old secret is invalid but ids come from the old row (id lookup)", async () => {
    const oldHash = fingerprintSecret(ROTATED_OLD);
    rows.push({
      id: "cc200000-0000-4000-8000-000000000099",
      org_id: ORG,
      employee_id: EMP,
      secret_prefix: ROTATED_OLD.slice(0, 14),
      secret_hash: oldHash,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      revoked_at: null,
    });
    currentBinding = {
      employeeId: EMP,
      orgId: ORG,
      status: "linked",
      credentialGeneration: 2,
      credentialFingerprint: fingerprintSecret(LIVE),
    };
    const r = await resolveEmployeeCredential(req(ROTATED_OLD));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("invalid_credential");
    expect(r.orgId).toBe(ORG);
    expect(r.employeeId).toBe(EMP);
    expect(touches).toEqual([]);
  });
});
