import { randomUUID } from "node:crypto";
import type { ApprovalRequest } from "@/lib/types";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { mapApprovalRow } from "@/lib/data/mappers";
import { demoGetApproval } from "@/lib/data/demo-approvals-store";
import { assertApprovalExecutionAuthority } from "./execution-authority";
import { canFulfillApproval } from "./workflow-integration";

type Result = { ok: boolean; error?: string };
type State = "running" | "succeeded" | "failed" | "uncertain";
const demoClaims = new Map<string, { state: State; result?: Result | null }>();
// These failures are known to precede provider effects. Unknown outcomes are
// never auto-retried: a timeout may have happened AFTER the provider accepted.
const retryable = new Set(["slack_token_missing", "missing_scope", "not_in_channel", "channel_not_found",
  "invalid_auth", "token_revoked", "account_inactive", "slack_identity_unbound", "slack_identity_not_linked", "posting_identity_unlinked"]);

/** All immediate, MCP reinvoke, proxy and W2 fulfillment shares this DB claim. */
export async function executeApproval<T extends Result>(
  approval: ApprovalRequest, execute: () => Promise<T | null>
): Promise<T | null> {
  await assertApprovalExecutionAuthority(approval);
  const workflow = await canFulfillApproval(approval);
  if (!workflow.canFulfill) throw new Error(workflow.reason);
  const claimId = randomUUID();
  const demoKey = `${approval.orgId}:${approval.id}`;
  const admin = isDemoMode() ? null : createSupabaseAdminClient();
  if (isDemoMode()) {
    const prior = demoClaims.get(demoKey);
    if (prior?.state === "succeeded") return (prior.result ?? null) as T | null;
    if (prior && prior.state !== "failed") throw new Error(`approval_execution_${prior.state}`);
    demoClaims.set(demoKey, { state: "running" });
    const current = await demoGetApproval(approval.id);
    if (current && current.orgId === approval.orgId) Object.assign(approval, current);
  } else {
    if (!admin) throw new Error("approval_execution_unavailable");
    const { data, error } = await admin.rpc("claim_approval_execution", { p_id: approval.id, p_org: approval.orgId, p_claim: claimId });
    if (error || !data) throw new Error("approval_execution_unavailable");
    if (data.state === "succeeded") {
      const current = mapApprovalRow(data.approval);
      Object.assign(approval, current);
      return (current.metadata.adminFulfillment ?? current.metadata.fulfillment ?? null) as T | null;
    }
    if (data.state !== "claimed") throw new Error(`approval_execution_${data.state}`);
    Object.assign(approval, mapApprovalRow(data.approval));
  }
  const finish = async (state: State, result?: T | null) => {
    if (isDemoMode()) { demoClaims.set(demoKey, { state, result }); return; }
    const { data, error } = await admin!.rpc("finish_approval_execution", {
      p_id: approval.id, p_org: approval.orgId, p_claim: claimId, p_state: state,
    });
    if (error || !data) throw new Error("approval_execution_outcome_unknown");
  };
  try {
    await assertApprovalExecutionAuthority(approval);
    const currentWorkflow = await canFulfillApproval(approval);
    if (!currentWorkflow.canFulfill) throw new Error(currentWorkflow.reason);
  }
  catch (error) { await finish("failed"); throw error; }
  let result: T | null;
  try { result = await execute(); }
  catch { await finish("uncertain"); throw new Error("approval_execution_outcome_unknown"); }
  await finish(result?.ok ? "succeeded" : !result || retryable.has(result.error || "") ? "failed" : "uncertain", result);
  return result;
}
