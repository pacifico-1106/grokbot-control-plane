/**
 * 木村 10/12 07:15 (3) [LOW]: the wrong-order-deploy safety net applies ONLY when the hold
 * schema is ENTIRELY absent (employees.hold_state / hold_id, orgs.hold_state / hold_id and
 * the employee_holds table are all missing). Partly present → fail closed (503
 * hold_state_unavailable) + an ops alert.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

type Res = { data: unknown; error: unknown };
const MISSING = (t: string, c: string) => ({ code: "42703", message: `column ${t}.${c} does not exist` });
const NO_TABLE = { code: "PGRST205", message: "Could not find the table 'public.employee_holds' in the schema cache" };
let readResult: Record<string, Res> = {};
/** probe key "employees.hold_state" etc. → error (missing) or null (present) */
let probe: Record<string, unknown> = {};

mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: () => ({ maybeSingle: async () => readResult[table] ?? { data: null, error: { code: "42501", message: "denied" } } }),
        limit: async () => {
          const key = table === "employee_holds" ? "employee_holds" : `${table}.${cols}`;
          const err = key in probe ? probe[key] : { code: "57014", message: "unexpected probe " + key };
          return { data: [], error: err };
        },
      }),
    }),
  }),
  createSupabaseServerClient: () => null,
}));
mock.module("@/lib/data/audit", () => ({ appendAuditEvent: async () => undefined }));

const hold = await import("@/lib/safety/hold");
const ORG = "11111111-1111-4111-8111-111111111111";
const EMP = "22222222-2222-4222-8222-222222222222";

let notInstalled: unknown[] = [];
let partial: unknown[] = [];
beforeEach(() => {
  notInstalled = []; partial = [];
  hold.__setHoldReaderForTests(null);
  hold.__resetHoldAuditThrottleForTests();
  hold.__setHoldNotInstalledAlertForTests(async (i) => { notInstalled.push(i); });
  hold.__setHoldSchemaPartialAlertForTests(async (i) => { partial.push(i); });
  readResult = {
    employees: { data: null, error: MISSING("employees", "hold_state") },
    orgs: { data: null, error: MISSING("orgs", "hold_state") },
  };
  probe = {
    "employees.hold_state": MISSING("employees", "hold_state"),
    "employees.hold_id": MISSING("employees", "hold_id"),
    "orgs.hold_state": MISSING("orgs", "hold_state"),
    "orgs.hold_id": MISSING("orgs", "hold_id"),
    employee_holds: NO_TABLE,
  };
});
afterEach(() => {
  hold.__setHoldNotInstalledAlertForTests(null);
  hold.__setHoldSchemaPartialAlertForTests(null);
});
const check = () => hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" });

test("ENTIRELY absent (4 columns + table missing) → safety net: allowed, not-installed alert", async () => {
  expect(await check()).toEqual({ ok: true });
  expect(notInstalled.length).toBe(1);
  expect(partial.length).toBe(0);
});

const partials: Array<[string, () => void]> = [
  ["employee_holds table exists, columns missing", () => { probe.employee_holds = null; }],
  ["employees.hold_id exists, hold_state missing", () => { probe["employees.hold_id"] = null; }],
  ["orgs columns exist, employees columns missing", () => { probe["orgs.hold_state"] = null; probe["orgs.hold_id"] = null; }],
  ["a probe fails for another reason (timeout)", () => { probe["orgs.hold_id"] = { code: "57014", message: "canceling statement due to statement timeout" }; }],
];
for (const [name, setup] of partials) {
  test(`PARTLY present: ${name} → 503 hold_state_unavailable + ops alert, no safety net`, async () => {
    setup();
    const r = await check();
    expect(r.ok ? "ok" : r.code).toBe("hold_state_unavailable");
    expect(partial.length).toBeGreaterThanOrEqual(1);
    expect(notInstalled.length).toBe(0);
  });
}

test("mixed reads: employee columns missing but the org row reads fine → fail closed + alert", async () => {
  readResult.orgs = { data: { id: ORG, hold_state: null, hold_id: null }, error: null };
  probe["orgs.hold_state"] = null; probe["orgs.hold_id"] = null;
  const r = await check();
  expect(r.ok ? "ok" : r.code).toBe("hold_state_unavailable");
  expect(partial.length).toBeGreaterThanOrEqual(1);
});

test("mixed at the checkpoint (reader says not_installed for one, found for the other) → fail closed + alert", async () => {
  hold.__setHoldReaderForTests({
    employee: async () => ({ state: "not_installed", detail: "employees" }),
    org: async () => ({ state: "found", orgId: ORG, holdState: null, holdId: null }),
  });
  const r = await check();
  expect(r.ok ? "ok" : r.code).toBe("hold_state_unavailable");
  expect(partial.length).toBe(1);
  expect(notInstalled.length).toBe(0);
});
