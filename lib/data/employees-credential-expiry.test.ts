/**
 * listEmployees / getEmployeeById (production path) carry the current
 * credential's expires_at, taken from the NEWEST non-revoked credentials row,
 * and never select key material. Mocked service-role client; no network.
 */
import { describe, expect, mock, test } from "bun:test";

type Call = { table: string; select: string; filters: string[] };
const calls: Call[] = [];
let credRows: Array<Record<string, unknown>> = [];
const EMP = { id: "emp_1", org_id: "org_a", display_name: "A", role_label: "r", status: "active", scopes: [], created_at: "2026-09-01T00:00:00Z" };
function fakeClient() {
  return {
    from(table: string) {
      const call: Call = { table, select: "", filters: [] };
      calls.push(call);
      const result = () => (table === "employees" ? { data: [EMP], error: null } : { data: credRows, error: null });
      const chain: Record<string, unknown> = {};
      chain.select = (s: string) => { call.select = s; return chain; };
      for (const m of ["eq", "is", "order", "limit"]) chain[m] = (...a: unknown[]) => { call.filters.push(`${m}:${a.map(String).join(",")}`); return chain; };
      chain.maybeSingle = async () => {
        if (table === "employees") return { data: EMP, error: null };
        return { data: credRows[0] ?? null, error: null };
      };
      chain.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ko);
      return chain;
    },
  };
}
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => fakeClient() }));
mock.module("@/lib/mode", () => ({ isDemoMode: () => false, runtimeModeLabel: () => "production" }));
const { listEmployees, getEmployeeById } = await import("./employees");

describe("credential expiry on employee reads", () => {
  test("listEmployees: newest non-revoked credential's id + expires_at, ordered newest first", async () => {
    calls.length = 0;
    credRows = [
      { id: "cred_new", employee_id: "emp_1", expires_at: "2026-09-23T00:00:00Z", created_at: "2026-08-24T00:00:00Z" },
      { id: "cred_old", employee_id: "emp_1", expires_at: null, created_at: "2026-07-01T00:00:00Z" },
    ];
    const [e] = await listEmployees("org_a");
    expect(e.credentialId).toBe("cred_new");
    expect(e.credentialExpiresAt).toBe("2026-09-23T00:00:00Z");
    const cred = calls.find((c) => c.table === "credentials")!;
    expect(cred.filters).toContain("eq:org_id,org_a");
    expect(cred.filters).toContain("is:revoked_at,null");
    expect(cred.filters.some((f) => f.startsWith("order:created_at"))).toBe(true);
    expect(cred.select).toContain("expires_at");
    expect(cred.select).not.toMatch(/secret|\*/);
  });
  test("listEmployees: no credential → credentialId null, credentialExpiresAt null", async () => {
    credRows = [];
    const [e] = await listEmployees("org_a");
    expect(e.credentialId).toBeNull();
    expect(e.credentialExpiresAt ?? null).toBeNull();
  });
  test("getEmployeeById carries expires_at too, without key material", async () => {
    calls.length = 0;
    credRows = [{ id: "cred_x", expires_at: "2026-09-30T00:00:00Z" }];
    const e = await getEmployeeById("emp_1");
    expect(e?.credentialExpiresAt).toBe("2026-09-30T00:00:00Z");
    const cred = calls.find((c) => c.table === "credentials")!;
    expect(cred.select).toContain("expires_at");
    expect(cred.select).not.toMatch(/secret|\*/);
  });
});
