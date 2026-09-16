import { beforeEach, expect, mock, test } from "bun:test";
import type { ApprovalRequest } from "@/lib/types";
let initialized: boolean | null = true;
let rpcError = false, readError = false, baseUpdates = 0, voteCalls = 0;
const approval = { id: "ticket", orgId: "org", employeeId: "", status: "pending", purpose: "fixture", metadata: {} } as ApprovalRequest;
const instance = { id: "instance", approval_id: "ticket", org_id: "org", status: "active", current_stage_index: 0,
  policy_snapshot: { version: 1, policyId: "policy", policyName: "fixture", stages: [
    { id: "s", nameJa: "s", voterUserIds: ["member"], quorum: { type: "any" }, onReject: "fail_closed" } ] } };
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/data/approvals", () => ({
  getApprovalById: async (_id: string, org: string) => org === "org" ? approval : null,
  resolveApprovalWithoutWorkflow: async () => { baseUpdates++; return { ...approval, status: "approved" }; },
}));
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => ({
  rpc: async (name: string) => {
    if (name === "cast_approval_workflow_vote") { voteCalls++; return { data: null, error: { message: "fixture transaction failed" } }; }
    return { data: initialized, error: rpcError ? { message: "fixture outage" } : null };
  },
  from: (name: string) => {
    const result = () => ({ data: name === "approval_workflow_instances" ? instance : [], error: readError ? { message: "fixture read failed" } : null });
    const q = { select: () => q, eq: () => q, maybeSingle: async () => result(), order: async () => result() };
    return q;
  },
}) }));
const { resolveApprovalWithWorkflow } = await import("@/lib/approvals/workflow-integration");
const { getWorkflowInstanceByApprovalId, getOrgApprovalWorkflowPolicy } = await import("./data");
beforeEach(() => { initialized=true;rpcError=false;readError=false;baseUpdates=0;voteCalls=0; });

test("initialization failure or an invalid RPC response cannot fall back to a single approval", async () => {
  rpcError=true;
  await expect(resolveApprovalWithWorkflow("ticket","approved","reviewer","org",{actorId:"member"})).rejects.toThrow();
  rpcError=false;initialized=null;
  await expect(resolveApprovalWithWorkflow("ticket","approved","reviewer","org",{actorId:"member"})).rejects.toThrow();
  expect(baseUpdates).toBe(0);expect(voteCalls).toBe(0);
});
test("instance/policy read errors are failures, never an absent policy/instance", async () => {
  readError=true;
  await expect(getWorkflowInstanceByApprovalId("ticket")).rejects.toThrow();
  await expect(getOrgApprovalWorkflowPolicy("org")).rejects.toThrow();
  await expect(resolveApprovalWithWorkflow("ticket","approved","reviewer","org",{actorId:"member"})).rejects.toThrow();
  expect(baseUpdates).toBe(0);expect(voteCalls).toBe(0);
});
test("atomic voting failure never calls the legacy resolver", async () => {
  await expect(resolveApprovalWithWorkflow("ticket","approved","reviewer","org",{actorId:"member"})).rejects.toThrow("workflow_vote_failed");
  expect(voteCalls).toBe(1);expect(baseUpdates).toBe(0);
});
test("an explicit successful no-workflow result retains W1; other tenants cannot reach it", async () => {
  initialized=false;
  const denied=await resolveApprovalWithWorkflow("ticket","approved","reviewer","other",{actorId:"member"});
  expect(denied.ok).toBe(false);expect(baseUpdates).toBe(0);
  const result=await resolveApprovalWithWorkflow("ticket","approved","reviewer","org",{actorId:"member"});
  expect(result.ok).toBe(true);expect(result.workflowApplied).toBe(false);expect(baseUpdates).toBe(1);
});
