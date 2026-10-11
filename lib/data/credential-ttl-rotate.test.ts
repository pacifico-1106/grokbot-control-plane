/**
 * 八坂さん 2026-10-12 02:33 (via 木村): every 社員証 gets a 90-day expiry.
 * rotate (dashboard rotate AND the admin MCP reissue pickup, which calls the
 * same rotateCredential) inserts the new credentials row with
 * expires_at = now + 90 days. Existing rows are never given / changed an
 * expiry: the revoke step only sets revoked_at (no backfill).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type Op = { table: string; op: string; payload?: Record<string, unknown>; filters: string[] };
let ops: Op[] = [];
function client() {
  return {
    from(table: string) {
      const rec: Op = { table, op: "select", filters: [] };
      ops.push(rec);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const f of ["eq", "is", "neq", "order", "limit"]) chain[f] = (...a: unknown[]) => (rec.filters.push(`${f}:${a.join(",")}`), self());
      chain.select = () => self();
      chain.insert = (p: Record<string, unknown>) => ((rec.op = "insert"), (rec.payload = p), self());
      chain.update = (p: Record<string, unknown>) => ((rec.op = "update"), (rec.payload = p), self());
      chain.upsert = (p: Record<string, unknown>) => ((rec.op = "upsert"), (rec.payload = p), self());
      const result = () => {
        if (table === "employee_bindings") {
          return { data: { employee_id: "emp_1", org_id: "org_a", credential_generation: 2, credential_fingerprint: "f", status: "unlinked", created_at: "x", updated_at: "x" }, error: null };
        }
        if (table === "credentials" && rec.op === "insert") return { data: { id: "cred_new" }, error: null };
        return { data: null, error: null };
      };
      chain.single = async () => result();
      chain.maybeSingle = async () => result();
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
      return chain;
    },
  };
}
mock.module("@/lib/mode", () => ({ isDemoMode: () => false, isSupabaseConfigured: () => true, runtimeModeLabel: () => "production", isStripeConfigured: () => false, isResendConfigured: () => false }));
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => client(), createSupabaseServerClient: async () => null }));
const { rotateCredential } = await import("@/lib/data/bindings");
const { EMPLOYEE_CREDENTIAL_TTL_DAYS } = await import("@/lib/employees/credential-ttl");

const DAY = 86_400_000;
const snapshot = { secretPrefix: "gb_emp_x", scopes: [], allowedPurposes: [], approvalPolicy: "risk_based" as const, actionLimits: {}, spend: null, allowedAccounts: [] };

beforeEach(() => {
  ops = [];
});

describe("rotateCredential (production)", () => {
  test("new credentials row gets expires_at = now + 90 days", async () => {
    expect(EMPLOYEE_CREDENTIAL_TTL_DAYS).toBe(90);
    const before = Date.now();
    await rotateCredential("emp_1", "org_a", "fp_new", snapshot);
    const after = Date.now();
    const insert = ops.find((o) => o.table === "credentials" && o.op === "insert")!;
    expect(insert).toBeDefined();
    const at = Date.parse(String(insert.payload!.expires_at));
    expect(at).toBeGreaterThanOrEqual(before + 90 * DAY);
    expect(at).toBeLessThanOrEqual(after + 90 * DAY);
  });
  test("the revoke step only sets revoked_at: an existing row's (null) expires_at is never touched; no other credentials write", async () => {
    await rotateCredential("emp_1", "org_a", "fp_new", snapshot);
    const writes = ops.filter((o) => o.table === "credentials" && o.op !== "select");
    expect(writes.map((w) => w.op)).toEqual(["insert", "update"]);
    const revoke = writes[1];
    expect(Object.keys(revoke.payload!)).toEqual(["revoked_at"]);
    expect(revoke.filters).toContain("neq:id,cred_new");
  });
});
