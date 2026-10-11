/**
 * S3 (design §2.4 decision 8, 木村): AI can neither stop nor release — on EVERY route.
 * Each hold route × each AI credential form → 403 ai_cannot_hold, nothing changes.
 * Plus: no MCP tool (employee or admin) exposes a hold write.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// server-only is a build boundary (lib/admin/access); the route is exercised here deliberately.
mock.module("server-only", () => ({}));

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holds3r";

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const store = await import("@/lib/safety/hold-store");
const notify = await import("@/lib/safety/hold-notify");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const ROUTES: Array<[string, string, "GET" | "POST", Record<string, unknown>]> = [
  ["holds.stop", "@/app/api/holds/stop/route", "POST", { employeeId: EMP }],
  ["holds.stop (org)", "@/app/api/holds/stop/route", "POST", { scope: "org" }],
  ["holds.release.request", "@/app/api/holds/release/request/route", "POST", { holdId: "h", reason: "x" }],
  ["holds.release.approve", "@/app/api/holds/release/approve/route", "POST", { holdId: "h" }],
  ["holds.status", "@/app/api/holds/status/route", "GET", {}],
  ["admin.holds.stop", "@/app/api/admin/holds/stop/route", "POST", { orgId: ORG, employeeId: EMP }],
];
const AI_HEADERS: Array<[string, Record<string, string>]> = [
  ["社員証 Bearer gb_emp_", { authorization: "Bearer gb_emp_0123456789abcdef" }],
  ["tenant admin Bearer gb_adm_", { authorization: "Bearer gb_adm_0123456789abcdef" }],
  ["OAuth access token Bearer sp_at_", { authorization: "Bearer sp_at_0123456789abcdef" }],
  ["x-staffpass-credential", { "x-staffpass-credential": "gb_emp_0123456789abcdef" }],
  ["x-staffpass-admin-credential", { "x-staffpass-admin-credential": "gb_adm_0123456789abcdef" }],
  ["any other bearer", { authorization: "Bearer something" }],
];

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = { E: process.env.EMPLOYEE_HOLD_ENABLED, O: process.env.ORG_HOLD_ENABLED };
  process.env.EMPLOYEE_HOLD_ENABLED = "true";
  process.env.ORG_HOLD_ENABLED = "true";
  notify.__setHoldNotifierForTests({ tenant: async () => undefined, ops: async () => undefined });
  store.__resetDemoHoldsForTests();
});
afterEach(() => {
  if (saved.E === undefined) delete process.env.EMPLOYEE_HOLD_ENABLED; else process.env.EMPLOYEE_HOLD_ENABLED = saved.E;
  if (saved.O === undefined) delete process.env.ORG_HOLD_ENABLED; else process.env.ORG_HOLD_ENABLED = saved.O;
  notify.__setHoldNotifierForTests(null);
  store.__resetDemoHoldsForTests();
});

function req(method: "GET" | "POST", headers: Record<string, string>, body: Record<string, unknown>) {
  const url = method === "GET" ? `http://localhost/api/holds/status?employeeId=${EMP}` : "http://localhost/api/holds";
  return new Request(url, { method, headers: { "content-type": "application/json", ...headers }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
}

describe("every hold route refuses every AI credential form", () => {
  for (const [name, path, method, body] of ROUTES) {
    for (const [cred, headers] of AI_HEADERS) {
      test(`${name} × ${cred} → 403 ai_cannot_hold, nothing stopped / released`, async () => {
        const mod = await import(path);
        const res: Response = await mod[method](req(method, headers, body));
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe("ai_cannot_hold");
        expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok).toBe(true);
      });
    }
  }
  test("control: the same stop route with a human session (no credential header) stops", async () => {
    const { POST } = await import("@/app/api/holds/stop/route");
    const res = await POST(req("POST", {}, { employeeId: EMP }));
    expect(res.status).toBe(200);
    expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok).toBe(false);
  });
  test("AI-held release: an approved release cannot be pushed through with a credential either", async () => {
    const { POST } = await import("@/app/api/holds/stop/route");
    await POST(req("POST", {}, { employeeId: EMP }));
    const { POST: approve } = await import("@/app/api/holds/release/approve/route");
    const res = await approve(req("POST", { authorization: "Bearer gb_emp_x" }, { holdId: "any" }));
    expect(res.status).toBe(403);
    expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok).toBe(false);
  });
});

describe("no MCP tool writes a hold", () => {
  test("employee MCP and admin MCP tool lists have no stop / release tool", async () => {
    const sources = await Promise.all(["lib/mcp/tools.ts", "lib/mcp/admin-tools.ts"].map(async (f) => (await import("node:fs")).readFileSync(f, "utf8")));
    for (const src of sources) {
      expect(src).not.toMatch(/name:\s*["'`][^"'`]*(hold\.(start|release|stop)|emergency_stop|employees\.hold\.(start|release))/);
      expect(src).not.toMatch(/hold-actions|hold-store/);
    }
  });
});
