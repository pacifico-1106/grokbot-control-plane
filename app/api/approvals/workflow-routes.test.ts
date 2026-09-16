import { beforeEach, expect, mock, test } from "bun:test";
import type { ApprovalRequest } from "@/lib/types";
import type { WorkflowResolveResult } from "@/lib/approvals/workflow-integration";

const approval = {
  id: "fixture-approval", orgId: "fixture-org", employeeId: "fixture-employee", status: "approved",
  statusToken: "fixture-private-status-token", pollPath: "fixture-private-poll-path",
  metadata: { adminFulfillment: { ok: true, oneTimeSecret: "fixture-private-secret" } },
} as unknown as ApprovalRequest;
let result: WorkflowResolveResult;
let allowed = true;
let resolutionError: Error | null = null;
let resolves = 0, adminCalls = 0, invokeCalls = 0, notifications = 0;

mock.module("@/lib/auth/session", () => ({ getCurrentOrgId: async () => "fixture-org" }));
mock.module("@/lib/team/demo-actor", () => ({ requireCapability: async () => allowed
  ? { ok: true, actor: { id: "reviewer", email: "reviewer@example.com" } }
  : { ok: false, response: new Response(null, { status: 403 }) } }));
mock.module("@/lib/data", () => ({
  getApprovalById: async () => approval, getEmployee: async () => null, runtimeModeLabel: () => "demo",
}));
mock.module("@/lib/approvals/workflow-integration", () => ({ resolveApprovalWithWorkflow: async () => {
  resolves++;
  if (resolutionError) throw resolutionError;
  return result;
} }));
mock.module("@/lib/admin-mcp/fulfill-admin", () => ({ fulfillApprovedAdmin: async () => { adminCalls++; } }));
mock.module("@/lib/approvals/fulfill", () => ({ fulfillApprovedInvoke: async () => { invokeCalls++; } }));
mock.module("@/lib/approvals/resolve-side-effects", () => ({ runApprovalResolveSideEffects: async () => {
  notifications++; return { notified: [] };
} }));
const { POST: approve } = await import("./[id]/approve/route");
const { POST: reject } = await import("./[id]/reject/route");
const request = () => new Request("https://fixture.invalid/api/approvals/fixture-approval/approve", { method: "POST" });
const context = () => ({ params: Promise.resolve({ id: approval.id }) });

beforeEach(() => {
  allowed = true; resolutionError = null;
  resolves = adminCalls = invokeCalls = notifications = 0;
  result = { ok: true, approval, workflowApplied: true, workflowComplete: true,
    workflowApproved: true, workflowRejected: false, progress: null, reason: "approved" };
});

test("successful F8 approval uses the existing fulfillment wrappers and returns a public DTO", async () => {
  const response = await approve(request(), context());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(adminCalls).toBe(1); expect(invokeCalls).toBe(1); expect(notifications).toBe(1);
  expect(body.approval.metadata.adminFulfillment).toEqual({ ok: true });
  expect(body.approval.statusToken).toBe(""); expect(body.approval.pollPath).toBe("");
});

test("successful rejection returns a public DTO without fulfillment", async () => {
  result = { ...result, workflowApproved: false, workflowRejected: true,
    approval: { ...approval, status: "rejected" } };
  const response = await reject(request(), context());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.approval.metadata.adminFulfillment).toEqual({ ok: true });
  expect(body.approval.statusToken).toBe(""); expect(body.approval.pollPath).toBe("");
  expect(adminCalls).toBe(0); expect(invokeCalls).toBe(0); expect(notifications).toBe(1);
});

test("failed resolution, intermediate votes and not-found results produce no execution or notifications", async () => {
  for (const route of [approve, reject]) {
    for (const patch of [
      { ok: false, approval: null, reason: "resolve_failed" },
      { ok: true, workflowComplete: false, workflowApproved: false },
      { ok: false, approval: null, reason: "approval_not_found" },
    ]) {
      const previous = result;
      result = { ...result, ...patch };
      const response = await route(request(), context());
      expect(response.status).toBe(patch.reason === "approval_not_found" ? 404 : 200);
      expect(adminCalls).toBe(0); expect(invokeCalls).toBe(0); expect(notifications).toBe(0);
      result = previous;
    }
  }
});

test("denied capability never resolves; self-approval denial never fulfills or notifies", async () => {
  allowed = false;
  for (const route of [approve, reject]) expect((await route(request(), context())).status).toBe(403);
  expect(resolves).toBe(0);
  allowed = true; resolutionError = new Error("self_approval_denied");
  for (const route of [approve, reject]) expect((await route(request(), context())).status).toBe(403);
  expect(adminCalls).toBe(0); expect(invokeCalls).toBe(0); expect(notifications).toBe(0);
});
