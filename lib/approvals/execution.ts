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
const retryable = new Set(["slack_token_missing", "slack_conversation_bot_token_missing", "missing_scope", "not_in_channel", "channel_not_found",
  "invalid_auth", "token_revoked", "account_inactive", "slack_identity_unbound", "slack_identity_not_linked", "posting_identity_unlinked",
  // Fulfill-time policy stops (lib/approvals/fulfill-policy-recheck.ts) happen before any provider call.
  "fulfill_blocked_tool_denied", "fulfill_blocked_mail_policy", "fulfill_blocked_employee_unavailable",
  // Duplicate-reply prevention (lib/comm-reply-dedup/guard.ts): closed / stopped before any provider call.
  "approval_superseded", "approval_expired", "fulfill_blocked_dedup_unavailable",
  // Duplicate post guard v2: the gate met an earlier post with an unknown outcome
  // and stopped before any provider call; the approval stays approved and may run
  // again once that post is verified absent (released) or ages out.
  // ("post_outcome_unknown" is NOT here: that post may have gone out.)
  "duplicate_post_uncertain",
  // Thread single-flight (THREAD_SINGLE_FLIGHT_ENABLED, lib/thread-guard): stopped
  // before any provider call. busy / unavailable → may run again. moved_on
  // closes the approval as superseded (terminal); only when that close lost a
  // race does the approval stay approved, and the next run re-checks and closes.
  "thread_busy", "thread_moved_on", "thread_guard_unavailable"]);
// Per-tool additions: refusals that tool returns BEFORE any write and that it
// re-checks from scratch on every run (so the same approvalId may run again,
// e.g. after the employee re-authorizes Slack). Scoped by tool so the same
// code from another tool keeps that tool's rule.
// employees.postingIdentity.set: POSTING_IDENTITY_RETRYABLE_REFUSAL_CODES
// (lib/admin-mcp/posting-identity-tool.ts; equality pinned by its test).
const retryableByTool: Record<string, ReadonlySet<string>> = {
  "employees.postingIdentity.set": new Set([
    "user_token_missing", "user_token_invalid", "user_token_scope_check_failed",
    "missing_scope_chat_write", "slack_account_not_allowed",
  ]),
  // comm.delete (lib/comm-delete/run.ts): every run re-checks the flag, the
  // employee, the own-post record and "already deleted" from scratch, and a
  // second chat.delete of a gone message maps to already_deleted — so a
  // re-run can never delete anything beyond the approved own post.
  "comm.delete": new Set([
    "comm_delete_disabled", "invalid_delete_target", "not_supported", "post_not_found_or_not_owned", "too_old",
    // approved-target check in lib/comm-delete/fulfill.ts: stops before any provider call.
    "approved_target_missing", "approved_target_mismatch",
    "comm_delete_unavailable", "cant_delete_message", "slack_token_identity_mismatch",
    "slack_delete_timeout", "slack_delete_fetch_failed",
  ]),
};

/** Failure → claim state "failed" (may run again) instead of "uncertain". */
export function isRetryableApprovalFailure(tool: string, code: string): boolean {
  if (!code) return false;
  return retryable.has(code) || Boolean(retryableByTool[tool]?.has(code));
}

function approvalToolName(approval: ApprovalRequest): string {
  return String(approval.metadata?.adminTool || approval.tool || "").trim();
}

/**
 * The stored result when the ticket already ran successfully (same rule as
 * claim_approval_execution: metadata.fulfillment.ok / adminFulfillment.ok).
 * 木村 2026-10-09 23:48: such a ticket — even an old one with no execution
 * claim — only hands back that result; nothing runs, writes or sends again.
 */
function storedSuccess<T extends Result>(approval: ApprovalRequest | null | undefined): T | null {
  const metadata = approval?.metadata ?? {};
  for (const key of ["adminFulfillment", "fulfillment"] as const) {
    const value = metadata[key];
    if (value && typeof value === "object" && (value as { ok?: unknown }).ok === true) return value as T;
  }
  return null;
}

/** All immediate, MCP reinvoke, proxy and W2 fulfillment shares this DB claim. */
export async function executeApproval<T extends Result>(
  approval: ApprovalRequest, execute: () => Promise<T | null>
): Promise<T | null> {
  const already = storedSuccess<T>(approval);
  if (already) return already;
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
    // Mirror the SQL claim: a fresh row that already shows success is "succeeded".
    const fresh = await demoGetApproval(approval.id);
    const freshDone = fresh && fresh.orgId === approval.orgId ? storedSuccess<T>(fresh) : null;
    if (freshDone) return freshDone;
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
  await finish(
    result?.ok ? "succeeded" : !result || isRetryableApprovalFailure(approvalToolName(approval), result.error || "") ? "failed" : "uncertain",
    result
  );
  return result;
}
