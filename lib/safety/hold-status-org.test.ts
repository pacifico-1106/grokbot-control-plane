/**
 * GET /api/holds/status?scope=org must read the org pointer (not an employee hold
 * filter). After an org stop it returns held — the panel's 解除を申請 source.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holdst";

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const store = await import("@/lib/safety/hold-store");
const notify = await import("@/lib/safety/hold-notify");
const { startHold } = await import("@/lib/safety/hold-actions");
const { getRuntimeMemberById } = await import("@/lib/demo-data");
const { writeDesignatedAdminMemberIds } = await import("@/lib/approver-authority/designated-admins");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
let saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  saved = { E: process.env.EMPLOYEE_HOLD_ENABLED, O: process.env.ORG_HOLD_ENABLED };
  process.env.EMPLOYEE_HOLD_ENABLED = "true";
  process.env.ORG_HOLD_ENABLED = "true";
  notify.__setHoldNotifierForTests({ tenant: async () => undefined, ops: async () => undefined });
  store.__resetDemoHoldsForTests();
  hold.__setHoldReaderForTests(null);
  await writeDesignatedAdminMemberIds(ORG, ["mem_2"]);
});
afterEach(async () => {
  if (saved.E === undefined) delete process.env.EMPLOYEE_HOLD_ENABLED; else process.env.EMPLOYEE_HOLD_ENABLED = saved.E;
  if (saved.O === undefined) delete process.env.ORG_HOLD_ENABLED; else process.env.ORG_HOLD_ENABLED = saved.O;
  notify.__setHoldNotifierForTests(null);
  store.__resetDemoHoldsForTests();
  hold.__setHoldReaderForTests(null);
  await writeDesignatedAdminMemberIds(ORG, []);
});

async function status(query: string, member = "mem_1") {
  const { GET } = await import("@/app/api/holds/status/route");
  const res = await GET(new Request(`http://localhost/api/holds/status?${query}`, {
    headers: { "x-member-id": member },
  }));
  return { status: res.status, cache: res.headers.get("cache-control"), body: await res.json() as Record<string, unknown> };
}

describe("GET /api/holds/status?scope=org", () => {
  test("missing employeeId without scope=org → 400; scope=org is ok", async () => {
    expect((await status("")).status).toBe(400);
    const r = await status("scope=org");
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("none");
    expect(r.body.orgEnabled).toBe(true);
    expect(String(r.cache || "")).toMatch(/no-store/);
  });
  test("ops_console org stop → opsHold true (HoldPanel hides 解除を申請)", async () => {
    const stop = await startHold({
      orgId: ORG, employeeId: null,
      actor: { type: "ops", opsId: "ops@staffpass.example", surface: "ops_console" },
    });
    expect(stop.ok).toBe(true);
    const r = await status("scope=org");
    expect(r.body.state).toBe("held");
    expect((r.body.hold as { opsHold?: boolean; startedVia?: string } | null)?.startedVia).toBe("ops_console");
    expect((r.body.hold as { opsHold?: boolean } | null)?.opsHold).toBe(true);
  });
  test("after org stop, scope=org is held with that holdId (not none)", async () => {
    const stop = await startHold({
      orgId: ORG, employeeId: null,
      actor: { type: "member", member: getRuntimeMemberById("mem_1")!, surface: "web", demoAuthTime: new Date().toISOString() },
    });
    expect(stop.ok).toBe(true);
    if (!stop.ok) return;
    const r = await status("scope=org");
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("held");
    expect((r.body.hold as { id?: string } | null)?.id).toBe(stop.holdId);
    const emp = await status(`employeeId=${EMP}`);
    expect(emp.body.state).toBe("none");
  });
  test("unreadable org pointer → unknown, not none", async () => {
    hold.__setHoldReaderForTests({
      employee: async () => ({ state: "error", detail: "x" }),
      org: async () => ({ state: "error", detail: "x" }),
    });
    const r = await status("scope=org");
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("unknown");
    expect(r.body.hold).toBe(null);
  });
});
