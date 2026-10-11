/**
 * Production revocation-check reader (木村 review of #267, 2026-10-05): a DB
 * read error, a thrown client or a missing service-role client is "error"
 * (→ the attempt is deferred), never "no row" (→ revoke). Production mode with
 * a mocked service-role client; dummy values, no network.
 */
import { describe, expect, mock, test } from "bun:test";

type Res = { data: unknown; error: unknown };
let tables: Record<string, Res | "throw"> = {};
let clientAvailable = true;
function fakeClient() {
  return {
    from(table: string) {
      const res = tables[table];
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => { if (res === "throw") throw new Error("fetch failed"); return res; };
      return chain;
    },
  };
}
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => (clientAvailable ? fakeClient() : null) }));
const principal = await import("@/lib/mcp-events/principal");

const err = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
const none = { data: null, error: null };
const SUB = { orgId: "org_1", employeeId: "emp_x", credentialGeneration: 3, credentialFingerprint: "fp", credentialId: "cred_x" };
const LIVE = {
  employee_bindings: { data: { employee_id: "emp_x", org_id: "org_1", status: "active", credential_generation: 3, credential_fingerprint: "fp" }, error: null },
  employees: { data: { id: "emp_x", org_id: "org_1", status: "active" }, error: null },
  credentials: { data: { revoked_at: null, expires_at: null }, error: null },
};

describe("supabasePrincipalReader", () => {
  test("error → error, no row → missing, row → found, throw → error, no client → error", async () => {
    const r = principal.supabasePrincipalReader();
    clientAvailable = true;
    tables = { employee_bindings: err, employees: err, credentials: err };
    expect((await r.binding("emp_x")).state).toBe("error");
    expect((await r.employee("emp_x")).state).toBe("error");
    expect((await r.credential("cred_x", "emp_x")).state).toBe("error");
    tables = { employee_bindings: none, employees: none, credentials: none };
    expect((await r.binding("emp_x")).state).toBe("missing");
    expect((await r.employee("emp_x")).state).toBe("missing");
    expect((await r.credential("cred_x", "emp_x")).state).toBe("missing");
    tables = { ...LIVE };
    expect(await r.binding("emp_x")).toMatchObject({ state: "found", value: { orgId: "org_1", status: "active", credentialGeneration: 3, credentialFingerprint: "fp" } });
    expect(await r.employee("emp_x")).toMatchObject({ state: "found", value: { orgId: "org_1", status: "active" } });
    expect(await r.credential("cred_x", "emp_x")).toMatchObject({ state: "found", value: { revokedAt: null, expiresAt: null } });
    tables = { employee_bindings: "throw", employees: "throw", credentials: "throw" };
    expect((await r.binding("emp_x")).state).toBe("error");
    clientAvailable = false;
    expect((await r.binding("emp_x")).state).toBe("error");
    clientAvailable = true;
  });

  test("checkSubscriptionPrincipal on the production reader: each read error → unavailable; confirmed states → revoked / ok", async () => {
    principal.__setPrincipalReaderForTests(principal.supabasePrincipalReader());
    try {
      for (const table of ["employee_bindings", "employees", "credentials"] as const) {
        tables = { ...LIVE, [table]: err };
        expect(await principal.checkSubscriptionPrincipal(SUB, Date.now())).toMatchObject({ ok: false, kind: "unavailable", reason: "revocation_check_unavailable" });
      }
      clientAvailable = false;
      expect(await principal.checkSubscriptionPrincipal(SUB, Date.now())).toMatchObject({ ok: false, kind: "unavailable" });
      clientAvailable = true;
      tables = { ...LIVE, credentials: none };
      expect(await principal.checkSubscriptionPrincipal(SUB, Date.now())).toMatchObject({ ok: false, kind: "revoked", reason: "credential_missing" });
      tables = { ...LIVE, employee_bindings: { data: { ...LIVE.employee_bindings.data, credential_generation: 4 }, error: null } };
      expect(await principal.checkSubscriptionPrincipal(SUB, Date.now())).toMatchObject({ ok: false, kind: "revoked", reason: "credential_rotated" });
      tables = { ...LIVE, employee_bindings: { data: { ...LIVE.employee_bindings.data, credential_fingerprint: "other" }, error: null } };
      expect(await principal.checkSubscriptionPrincipal(SUB, Date.now())).toMatchObject({ ok: false, kind: "revoked", reason: "credential_rotated" });
      tables = { ...LIVE, employees: { data: { id: "emp_x", org_id: "org_1", status: "suspended" }, error: null } };
      expect(await principal.checkSubscriptionPrincipal(SUB, Date.now())).toMatchObject({ ok: false, kind: "revoked", reason: "employee_suspended" });
      tables = { ...LIVE };
      expect(await principal.checkSubscriptionPrincipal(SUB, Date.now())).toEqual({ ok: true });
    } finally {
      principal.__setPrincipalReaderForTests(null);
    }
  });
});
