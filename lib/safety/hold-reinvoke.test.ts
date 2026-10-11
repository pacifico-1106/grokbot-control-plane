/**
 * 木村 10/12 (HIGH), from /workspace/p0/employee-holds-20261012/s2-repro/kimura-held-rerun.test.ts:
 * a re-invoke that passes the approvalId of a ticket a hold touched must not run
 * (priorApprovalOk is shared by mail.send, commerce.order, calendar, comm.send and
 * attachment resends; the guard sits where it is computed).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { getApprovalById, resolveApproval } from "@/lib/data";
import { updateApprovalMetadata } from "@/lib/data/approvals";
import { resetDemoMailPolicy, setOrgMailPolicy } from "@/lib/data/mail-policy";
import { normalizeMailPolicy } from "@/lib/mail-policy/validate";
import type { GatewayInvokeRequest } from "@/lib/types";

afterEach(() => resetDemoMailPolicy());
const invokeSales = (body: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_sales", credentialId: "cred_sales", body });

async function approvedMailTicket() {
  await setOrgMailPolicy(DEMO_ORG.id, normalizeMailPolicy({ policyId: "mpp_k", policyName: "K", rules: [{ id: "mpr_k", audience: "any", sendMode: "needs_approval" }] as never }));
  const body: GatewayInvokeRequest = { tool: "mail.send", purpose: "sales.outreach", jobId: `job_k_${Math.random().toString(36).slice(2, 10)}`,
    args: { assetRef: "kb/public-faq", to: "buyer@customer.example", subject: "s", body: "b" } };
  const queued = await invokeSales(body);
  expect(queued.httpStatus).toBe(402);
  const approvalId = String(queued.body.approvalId);
  await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
  return { body, approvalId };
}

describe("approvalId re-invoke of a ticket a hold touched", () => {
  for (const [name, patch] of [
    ["heldByHoldId (during hold, then hold released)", { heldByHoldId: "11111111-1111-4111-8111-111111111111" }],
    ["closed_by_hold (after release)", { heldByHoldId: "11111111-1111-4111-8111-111111111111", holdOutcome: "closed_by_hold" }],
    ["malformed marker", { heldByHoldId: 42 }],
  ] as const) {
    test(`mail.send re-invoke with approvalId: ${name} → 409 approval_held, not sent`, async () => {
      const { body, approvalId } = await approvedMailTicket();
      const a = await getApprovalById(approvalId, DEMO_ORG.id);
      await updateApprovalMetadata(a!, patch as Record<string, unknown>);
      const r = await invokeSales({ ...body, approvalId });
      expect(r.httpStatus).toBe(409);
      expect(r.body.ok).toBe(false);
      expect(r.body.code).toBe("approval_held");
      const after = await getApprovalById(approvalId, DEMO_ORG.id);
      expect((after!.metadata as Record<string, unknown>).fulfillment).toBeUndefined();
    });
  }
  test("control: an unmarked approved ticket still re-invokes (not approval_held)", async () => {
    const { body, approvalId } = await approvedMailTicket();
    const r = await invokeSales({ ...body, approvalId });
    expect(r.body.code).not.toBe("approval_held");
    expect(r.httpStatus).toBe(200);
  });
});
