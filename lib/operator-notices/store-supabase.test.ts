/**
 * Supabase backend of the operator-notice store: visibility goes through the ONE SQL function
 * (rpc list_visible_operator_notices) with org / employee from the scope; receipts are read
 * with both org and employee filters; DB trigger errors map to the store codes.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type Call = { op: string; table?: string; args?: unknown; filters: Array<[string, unknown]> };
const calls: Call[] = [];
let rpcRows: unknown[] = [];
let nextError: { message: string } | null = null;

function builder(table: string) {
  const c: Call = { op: "from", table, filters: [] };
  calls.push(c);
  const b: Record<string, unknown> = {};
  const chain = (name: string) => (...a: unknown[]) => { c.filters.push([name, a.length === 1 ? a[0] : a]); return b; };
  for (const m of ["select", "eq", "in", "limit", "delete", "update"]) b[m] = chain(m);
  b.insert = (row: unknown) => { c.op = "insert"; c.args = row; return b; };
  b.upsert = (row: unknown, o: unknown) => { c.op = "upsert"; c.args = [row, o]; return Promise.resolve({ error: nextError }); };
  b.maybeSingle = async () => ({ data: null, error: nextError });
  b.single = async () => ({ data: null, error: nextError ?? { message: "x" } });
  b.then = (res: (v: unknown) => unknown) => res({ data: [], error: nextError });
  return b;
}
mock.module("@/lib/mode", () => ({ isDemoMode: () => false, isSupabaseConfigured: () => true }));
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => ({
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: unknown) => { calls.push({ op: "rpc", table: fn, args, filters: [] }); return { data: rpcRows, error: nextError }; },
  }),
}));

const s = await import("@/lib/operator-notices/store");
const A1 = { orgId: "11111111-1111-4111-8111-11111111111a", employeeId: "22222222-2222-4222-8222-2222222222a1" };
const saved = process.env.OPERATOR_NOTICES_ENABLED;
beforeEach(() => { calls.length = 0; rpcRows = []; nextError = null; process.env.OPERATOR_NOTICES_ENABLED = "true"; });
afterAll(() => { if (saved === undefined) delete process.env.OPERATOR_NOTICES_ENABLED; else process.env.OPERATOR_NOTICES_ENABLED = saved; mock.restore(); });

describe("supabase backend", () => {
  test("listVisible / count use rpc list_visible_operator_notices with the scope's org + employee, nothing else", async () => {
    await s.listVisible(A1, { now: new Date("2026-10-12T00:00:00Z") });
    await s.countForWhoami(A1);
    const rpcs = calls.filter((c) => c.op === "rpc");
    expect(rpcs.length).toBe(2);
    for (const r of rpcs) {
      expect(r.table).toBe("list_visible_operator_notices");
      expect(Object.keys(r.args as object).sort()).toEqual(["p_employee", "p_now", "p_org"]);
      expect(r.args).toMatchObject({ p_org: A1.orgId, p_employee: A1.employeeId });
    }
    // no direct read of operator_notices / targets for an employee scope
    expect(calls.some((c) => c.op === "from" && (c.table === "operator_notices" || c.table === "operator_notice_targets"))).toBe(false);
  });
  test("receipts are read with BOTH org_id and employee_id filters", async () => {
    await s.getReceipts(A1, ["ntc_01J00000000000000000000000"]);
    const q = calls.find((c) => c.table === "operator_notice_receipts")!;
    expect(q.filters).toContainEqual(["eq", ["org_id", A1.orgId]]);
    expect(q.filters).toContainEqual(["eq", ["employee_id", A1.employeeId]]);
  });
  test("recordListed only upserts ids the rpc returned as visible", async () => {
    await s.recordListed(A1, ["ntc_01J00000000000000000000000"]);
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
  });
  test("a DB read error is store_unavailable (never 'no notices')", async () => {
    nextError = { message: "connection refused" };
    await expect(s.listVisible(A1)).rejects.toMatchObject({ code: "store_unavailable" });
    await expect(s.countForWhoami(A1)).rejects.toMatchObject({ code: "store_unavailable" });
  });
});
