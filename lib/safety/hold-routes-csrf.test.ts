/**
 * 木村 10/12 08:31 (#349 item 3): stop / release APIs require a same-origin Origin and
 * Content-Type application/json. A text/plain body (a "simple" cross-site request that
 * skips CORS preflight) is no longer parsed as JSON; only SameSite=Lax protected them before.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holdcsrf";

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const store = await import("@/lib/safety/hold-store");
const notify = await import("@/lib/safety/hold-notify");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const POST_ROUTES: Array<[string, string, Record<string, unknown>]> = [
  ["holds.stop", "@/app/api/holds/stop/route", { employeeId: EMP }],
  ["holds.release.request", "@/app/api/holds/release/request/route", { holdId: "h", reason: "x" }],
  ["holds.release.approve", "@/app/api/holds/release/approve/route", { holdId: "h" }],
  ["admin.holds.stop", "@/app/api/admin/holds/stop/route", { orgId: ORG, employeeId: EMP }],
];

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = { E: process.env.EMPLOYEE_HOLD_ENABLED };
  process.env.EMPLOYEE_HOLD_ENABLED = "true";
  notify.__setHoldNotifierForTests({ tenant: async () => undefined, ops: async () => undefined });
  store.__resetDemoHoldsForTests();
});
afterEach(() => {
  if (saved.E === undefined) delete process.env.EMPLOYEE_HOLD_ENABLED; else process.env.EMPLOYEE_HOLD_ENABLED = saved.E;
  notify.__setHoldNotifierForTests(null);
  store.__resetDemoHoldsForTests();
});

const URL_ = "http://localhost/api/holds/x";
function post(headers: Record<string, string>, body: Record<string, unknown>) {
  return new Request(URL_, { method: "POST", headers: { "x-member-id": "mem_1", ...headers }, body: JSON.stringify(body) });
}
const operable = async () => (await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok;

describe("stop / release APIs: same-origin Origin + application/json only", () => {
  for (const [name, path, body] of POST_ROUTES) {
    test(`${name}: cross-origin Origin → 403 cross_origin_refused, nothing changes`, async () => {
      const mod = await import(path);
      const res: Response = await mod.POST(post({ origin: "https://evil.example", "content-type": "application/json" }, body));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("cross_origin_refused");
      expect(await operable()).toBe(true);
    });
    test(`${name}: missing Origin → 403 cross_origin_refused`, async () => {
      const mod = await import(path);
      const res: Response = await mod.POST(post({ "content-type": "application/json" }, body));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("cross_origin_refused");
      expect(await operable()).toBe(true);
    });
    test(`${name}: Origin "null" → 403`, async () => {
      const mod = await import(path);
      const res: Response = await mod.POST(post({ origin: "null", "content-type": "application/json" }, body));
      expect(res.status).toBe(403);
    });
    test(`${name}: same origin but text/plain (JSON-looking body) → 415 json_required, not parsed`, async () => {
      const mod = await import(path);
      for (const ct of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
        const headers: Record<string, string> = { origin: "http://localhost" };
        if (ct) headers["content-type"] = ct;
        const res: Response = await mod.POST(post(headers, body));
        expect(res.status).toBe(415);
        expect((await res.json()).error).toBe("json_required");
      }
      expect(await operable()).toBe(true);
    });
  }
  test("control: same origin + application/json (with charset) still stops", async () => {
    const { POST } = await import("@/app/api/holds/stop/route");
    const res = await POST(post({ origin: "http://localhost", "content-type": "application/json; charset=utf-8" }, { employeeId: EMP }));
    expect(res.status).toBe(200);
    expect(await operable()).toBe(false);
  });
});
