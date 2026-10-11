/**
 * 木村 10/12 option (a): wrong-order deploy safety net. Production reader
 * (supabase-js client mocked at the PostgREST-result level). Only "hold column /
 * table does not exist" means not installed (allow + loud ops alert); every other
 * error still fails closed; nothing is cached, so a migration takes effect on the
 * very next request.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

type Result = { data: unknown; error: unknown };
let employeesResult: Result = { data: null, error: null };
let orgsResult: Result = { data: null, error: null };
let reads = 0;

mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            reads++;
            return table === "employees" ? employeesResult : table === "orgs" ? orgsResult : { data: null, error: { code: "42501", message: "permission denied" } };
          },
        }),
      }),
    }),
  }),
  createSupabaseServerClient: () => null,
}));
mock.module("@/lib/data/audit", () => ({ appendAuditEvent: async () => undefined }));

const hold = await import("@/lib/safety/hold");

const ORG = "11111111-1111-4111-8111-111111111111";
const EMP = "22222222-2222-4222-8222-222222222222";
const HID = "33333333-3333-4333-8333-333333333333";
const MISSING_EMP = { data: null, error: { code: "42703", message: "column employees.hold_state does not exist", details: null, hint: null } };
const MISSING_ORG = { data: null, error: { code: "42703", message: "column orgs.hold_state does not exist", details: null, hint: null } };
const row = (hs: string | null, hid: string | null) => ({ data: { id: EMP, org_id: ORG, hold_state: hs, hold_id: hid }, error: null });
const orgRow = (hs: string | null, hid: string | null) => ({ data: { id: ORG, hold_state: hs, hold_id: hid }, error: null });

let alerts: Array<{ phase: string; suppressed: number }> = [];
beforeEach(() => {
  reads = 0;
  alerts = [];
  hold.__setHoldReaderForTests(null);
  hold.__resetHoldAuditThrottleForTests();
  hold.__setHoldNotInstalledAlertForTests(async (i) => { alerts.push(i); });
});
afterEach(() => hold.__setHoldNotInstalledAlertForTests(null));

const check = () => hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" });

test("missing hold column (42703 on employees + orgs) → allowed, one loud ops alert, throttled", async () => {
  employeesResult = MISSING_EMP;
  orgsResult = MISSING_ORG;
  expect(await check()).toEqual({ ok: true });
  expect(alerts).toEqual([{ phase: "gateway", suppressed: 0 }]);
  expect(await check()).toEqual({ ok: true });
  expect(alerts.length).toBe(1); // throttled, but still allowed
});

test("PostgREST schema-cache form (PGRST204, 'Could not find the hold_state column') is also 'not installed'", async () => {
  employeesResult = { data: null, error: { code: "PGRST204", message: "Could not find the 'hold_state' column of 'employees' in the schema cache" } };
  orgsResult = { data: null, error: { code: "PGRST204", message: "Could not find the 'hold_id' column of 'orgs' in the schema cache" } };
  expect(await check()).toEqual({ ok: true });
  expect(alerts.length).toBe(1);
});

const failClosed: Array<[string, unknown]> = [
  ["statement timeout (57014)", { code: "57014", message: "canceling statement due to statement timeout" }],
  ["permission denied (42501)", { code: "42501", message: "permission denied for table employees" }],
  ["network / fetch failure (no code)", { code: "", message: "TypeError: fetch failed" }],
  ["JWT / auth (PGRST301)", { code: "PGRST301", message: "JWT expired" }],
  ["42703 on ANOTHER column", { code: "42703", message: "column employees.org_id does not exist" }],
  ["PGRST204 on another column", { code: "PGRST204", message: "Could not find the 'status' column of 'employees' in the schema cache" }],
  ["42P01 on another table", { code: "42P01", message: 'relation "public.employees" does not exist' }],
  ["hold column named but not a missing error", { code: "22P02", message: "invalid input value for enum hold_state" }],
];
for (const [name, error] of failClosed) {
  test(`${name} → still 503 hold_state_unavailable, no 'not installed' alert`, async () => {
    employeesResult = { data: null, error };
    orgsResult = orgRow(null, null);
    const r = await check();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("hold_state_unavailable");
    expect(alerts).toEqual([]);
  });
}

test("missing row / other-org row / malformed value still fail closed", async () => {
  orgsResult = orgRow(null, null);
  employeesResult = { data: null, error: null };
  expect((await check()).ok).toBe(false);
  employeesResult = { data: { id: EMP, org_id: "99999999-9999-4999-8999-999999999999", hold_state: null, hold_id: null }, error: null };
  expect((await check()).ok).toBe(false);
  employeesResult = row("paused", HID);
  expect((await check()).ok).toBe(false);
  expect(alerts).toEqual([]);
});

test("org hold column present while employees' is missing → org hold still enforced", async () => {
  employeesResult = MISSING_EMP;
  orgsResult = orgRow("stopped", HID);
  const r = await check();
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe("org_on_hold");
});

test("migration lands (same reader, error gone) → a held employee is blocked on the very next request (no cache)", async () => {
  employeesResult = MISSING_EMP;
  orgsResult = MISSING_ORG;
  expect(await check()).toEqual({ ok: true });
  // the migration is applied: no deploy, no restart, no wait
  employeesResult = row("stopped", HID);
  orgsResult = orgRow(null, null);
  const before = reads;
  const r = await check();
  expect(reads).toBeGreaterThan(before); // re-read, not cached
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe("employee_on_hold");
});

test("column exists (a read just succeeded) and then a read fails → still 503, no 'not installed'", async () => {
  employeesResult = row(null, null);
  orgsResult = orgRow(null, null);
  expect(await check()).toEqual({ ok: true });
  employeesResult = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
  const r = await check();
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe("hold_state_unavailable");
  employeesResult = { data: null, error: { code: "PGRST000", message: "Could not connect with the database" } };
  expect((await check()).ok).toBe(false);
  expect(alerts).toEqual([]);
});

test("isHoldSchemaMissing: unit table", () => {
  expect(hold.isHoldSchemaMissing({ code: "42703", message: "column employees.hold_id does not exist" })).toBe(true);
  expect(hold.isHoldSchemaMissing({ code: "42P01", message: 'relation "public.employee_holds" does not exist' })).toBe(true);
  expect(hold.isHoldSchemaMissing({ code: "PGRST205", message: "Could not find the table 'public.employee_holds' in the schema cache" })).toBe(true);
  expect(hold.isHoldSchemaMissing({ code: "", message: 'column "hold_state" does not exist' })).toBe(true);
  expect(hold.isHoldSchemaMissing({ code: "", message: "hold_state does not exist maybe" })).toBe(false);
  expect(hold.isHoldSchemaMissing(null)).toBe(false);
  expect(hold.isHoldSchemaMissing("42703")).toBe(false);
});
