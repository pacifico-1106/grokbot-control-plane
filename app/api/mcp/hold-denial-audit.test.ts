/**
 * HOLD_DENIAL_AUDIT_ENABLED: /api/mcp hold 403 writes mcp_auth_failures via
 * recordMcpHoldDenied. Flag OFF / write failure → same 403 body and status.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const audits: Array<Record<string, unknown>> = [];
let auditThrow = false;
mock.module("@/lib/safety/hold-denial-audit", () => ({
  recordMcpHoldDenied: async (input: Record<string, unknown>) => {
    if (auditThrow) throw new Error("audit_unavailable");
    const v = (process.env.HOLD_DENIAL_AUDIT_ENABLED ?? "").trim().toLowerCase();
    if (!(v === "true" || v === "1" || v === "on" || v === "enabled")) return;
    audits.push(input);
  },
  recordSelfApprovalDenied: async () => undefined,
  isHoldDenialAuditEnabled: () => {
    const v = (process.env.HOLD_DENIAL_AUDIT_ENABLED ?? "").trim().toLowerCase();
    return v === "true" || v === "1" || v === "on" || v === "enabled";
  },
}));

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const { rotateCredential } = await import("@/lib/data");
const { fingerprintSecret } = await import("@/lib/bindings");
const { POST } = await import("./route");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const SECRET = `gb_emp_hold_denial_audit_${"c".repeat(16)}`;
const HOLD_ID = "00000000-0000-4000-8000-00000000d3n1";
const FLAG = "HOLD_DENIAL_AUDIT_ENABLED";
const ENV = [FLAG, "MCP_OAUTH_ENABLED", "MCP_AUTH_FAILURE_AUDIT_ENABLED", "MCP_AUTH_401_NEXT_STEP_JA_ENABLED"];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  audits.length = 0;
  auditThrow = false;
  hold.__setHoldReaderForTests(null);
  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, null);
  await rotateCredential(EMP, ORG, fingerprintSecret(SECRET));
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, null);
  hold.__setHoldReaderForTests(null);
});

const listTools = () =>
  POST(
    new Request("https://staffpass.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
  );

test("flag OFF: employee_on_hold 403 body unchanged and no hold-denial audit", async () => {
  hold.demoSetEmployeeHold(EMP, { kind: "stopped", holdId: HOLD_ID });
  const res = await listTools();
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(JSON.stringify(body)).toContain("employee_on_hold");
  expect(JSON.stringify(body)).not.toContain(SECRET);
  expect(JSON.stringify(body)).not.toContain(HOLD_ID);
  expect(audits).toEqual([]);
});

test("flag ON: employee_on_hold 403 records one row; body and status stay the same", async () => {
  process.env.HOLD_DENIAL_AUDIT_ENABLED = "1";
  hold.demoSetEmployeeHold(EMP, { kind: "stopped", holdId: HOLD_ID });
  const res = await listTools();
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error?.data?.code).toBe("employee_on_hold");
  expect(JSON.stringify(body)).not.toContain(SECRET);
  expect(JSON.stringify(body)).not.toContain(HOLD_ID);
  expect(audits).toHaveLength(1);
  expect(audits[0].kind).toBe("employee_on_hold");
  expect(audits[0].orgId).toBe(ORG);
  expect(audits[0].employeeId).toBe(EMP);
  expect(audits[0].holdId).toBe(HOLD_ID);
  expect(audits[0].method).toBe("tools/list");
  expect(JSON.stringify(audits)).not.toContain(SECRET);
});

test("flag ON: org_on_hold 403 records org + employee + holdId", async () => {
  process.env.HOLD_DENIAL_AUDIT_ENABLED = "1";
  hold.demoSetOrgHold(ORG, { kind: "stopped", holdId: HOLD_ID });
  const res = await listTools();
  expect(res.status).toBe(403);
  expect((await res.json()).error?.data?.code).toBe("org_on_hold");
  expect(audits).toHaveLength(1);
  expect(audits[0].kind).toBe("org_on_hold");
  expect(audits[0].orgId).toBe(ORG);
  expect(audits[0].employeeId).toBe(EMP);
  expect(audits[0].holdId).toBe(HOLD_ID);
});

test("flag ON: audit throw still returns the same 403 body", async () => {
  process.env.HOLD_DENIAL_AUDIT_ENABLED = "1";
  auditThrow = true;
  hold.demoSetEmployeeHold(EMP, { kind: "stopped", holdId: HOLD_ID });
  const res = await listTools();
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error?.data?.code).toBe("employee_on_hold");
  expect(body.error?.message).toBe("employee is on hold (emergency stop / leave)");
});
