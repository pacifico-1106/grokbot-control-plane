/**
 * 木村 10/12 07:15 (1) [MED]: the post-approval check (G4, also after the claim) and the
 * other late checkpoints must never reuse a "not held" read cached earlier in the request,
 * and the per-request reuse is scoped to ONE call (one JSON-RPC message).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const { assertApprovalExecutionAuthority } = await import("@/lib/approvals/execution-authority");
const { executeApproval } = await import("@/lib/approvals/execution");
type ApprovalRequest = import("@/lib/types").ApprovalRequest;

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const HID = "33333333-3333-4333-8333-333333333333";
let held = false;
let reads = 0;
beforeEach(() => {
  held = false; reads = 0;
  hold.__resetHoldAuditThrottleForTests();
  hold.__setHoldReaderForTests({
    employee: async () => { reads++; return { state: "found", orgId: ORG, holdState: held ? "stopped" : null, holdId: held ? HID : null }; },
    org: async () => { reads++; return { state: "found", orgId: ORG, holdState: null, holdId: null }; },
  });
});
afterEach(() => hold.__setHoldReaderForTests(null));

function approval(): ApprovalRequest {
  return {
    id: `apr_g4_${Math.random().toString(36).slice(2)}`, orgId: ORG, employeeId: EMP, credentialId: "cred_sales",
    title: "t", purpose: "sales.outreach", summary: "s", risk: "low", status: "approved", tool: "slack.post",
    createdAt: new Date().toISOString(), resolvedAt: new Date().toISOString(), resolvedBy: "mem_1", metadata: {},
  } as ApprovalRequest;
}

describe("late checkpoints always re-read inside a request scope", () => {
  for (const phase of ["approval_execution", "wake", "mcp_events", "pre_send"] as const) {
    test(`${phase}: a hold that lands after G1 is seen (no stale reuse)`, async () => {
      await hold.withHoldRequestScope(async () => {
        expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" })).ok).toBe(true);
        held = true;
        const r = await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase });
        expect(r.ok ? "ok" : r.code).toBe("employee_on_hold");
      });
    });
  }
  test("G4 assertApprovalExecutionAuthority (staffpass_get_approval_status / stuck_retry path) after G1 in the same request", async () => {
    await hold.withHoldRequestScope(async () => {
      expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" })).ok).toBe(true);
      held = true;
      await expect(assertApprovalExecutionAuthority(approval())).rejects.toThrow("employee_on_hold");
    });
  });
  test("executeApproval (G4 before and after the claim) inside a request that already read 'not held'", async () => {
    let ran = 0;
    await hold.withHoldRequestScope(async () => {
      expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok).toBe(true);
      held = true;
      await expect(executeApproval(approval(), async () => { ran++; return { ok: true }; })).rejects.toThrow("employee_on_hold");
    });
    expect(ran).toBe(0);
  });
  test("a fresh G4 read refreshes the scope: a later G3 in the same call sees the hold too", async () => {
    await hold.withHoldRequestScope(async () => {
      await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" });
      held = true;
      await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "approval_execution" });
      const r = await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" });
      expect(r.ok ? "ok" : r.code).toBe("employee_on_hold");
    });
  });
  test("G1 → G3 inside one call still reuses (the optimisation stays for the early checks)", async () => {
    await hold.withHoldRequestScope(async () => {
      await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" });
      await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" });
    });
    expect(reads).toBe(2);
  });
});

describe("reuse is scoped to one call (one JSON-RPC message)", () => {
  test("withHoldCallScope nested in a request scope starts empty: call 2 never sees call 1's read", async () => {
    await hold.withHoldRequestScope(async () => {
      await hold.withHoldCallScope(async () => {
        expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" })).ok).toBe(true);
      });
      held = true;
      await hold.withHoldCallScope(async () => {
        const r = await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" });
        expect(r.ok ? "ok" : r.code).toBe("employee_on_hold");
      });
    });
  });
  test("both MCP routes refuse JSON-RPC batches (so one HTTP request = one call scope)", async () => {
    for (const path of ["@/app/api/mcp/route", "@/app/api/mcp/admin/route"]) {
      const { POST } = await import(path);
      const res = await POST(new Request("http://localhost/api/mcp", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]),
      }));
      expect(res.status).toBe(400);
    }
  });
});
