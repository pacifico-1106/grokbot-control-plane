/**
 * Daily sweep proposal: turns a scan report into ONE always_human
 * accounts.suspend ticket in PLATFORM_OPS_ORG_ID. Never executes anything —
 * the ticket goes through the normal approval + fulfill path, where the
 * 八坂-only approver check and previewHash re-check apply.
 */
import { createApproval, listApprovals, appendAuditEvent } from "@/lib/data";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import type { AdminRequester } from "@/lib/admin-mcp/self-approval";
import { planSpamAction, publicPlan } from "./accounts";
import type { SpamScanReport } from "./scan";
import type { SpamStore } from "./store";

export const SPAM_SWEEP_ACTOR_ID = "cron:spam-sweep";

export type ProposeDeps = {
  createApproval: typeof createApproval;
  listApprovals: typeof listApprovals;
  notify: (approval: Awaited<ReturnType<typeof createApproval>>["approval"]) => Promise<unknown>;
  audit: typeof appendAuditEvent;
};

const defaultDeps: ProposeDeps = {
  createApproval,
  listApprovals,
  notify: (approval) => sendApprovalNotifications(approval, null),
  audit: appendAuditEvent,
};

export type ProposeResult =
  | { proposed: true; approvalId: string; orgCount: number }
  | { proposed: false; reason: string; approvalId?: string };

export async function proposeSuspendTicket(
  store: SpamStore,
  report: SpamScanReport,
  opsOrgId: string | null,
  overrides: Partial<ProposeDeps> = {},
  now: Date = new Date()
): Promise<ProposeResult> {
  const deps = { ...defaultDeps, ...overrides };
  if (!opsOrgId) return { proposed: false, reason: "platform_ops_not_configured" };
  if (!report.proposableOrgIds.length) return { proposed: false, reason: "no_candidates" };

  const pending = (await deps.listApprovals(opsOrgId)).find(
    (a) =>
      a.status === "pending" &&
      String(a.metadata?.adminTool || a.tool || "") === "accounts.suspend" &&
      (a.metadata?.adminRequester as { actorId?: string } | undefined)?.actorId === SPAM_SWEEP_ACTOR_ID
  );
  if (pending) return { proposed: false, reason: "pending_proposal_exists", approvalId: pending.id };

  const reason = `spam-sweep ${report.generatedAt.slice(0, 10)}: score>=70 候補（自動提案・人の承認必須）`;
  const plan = await planSpamAction(store, { action: "suspend", orgIds: [...report.proposableOrgIds].sort(), reason }, now);
  const eligible = plan.orgs.filter((o) => o.eligible).map((o) => o.orgId);
  if (!eligible.length) return { proposed: false, reason: "no_eligible_candidates" };
  // Re-plan with eligible orgs only so the ticket is executable as-is.
  const finalPlan = eligible.length === plan.orgs.length
    ? plan
    : await planSpamAction(store, { action: "suspend", orgIds: eligible, reason }, now);
  if (finalPlan.blockedCount > 0) return { proposed: false, reason: "plan_unstable" };

  const requester: AdminRequester = { kind: "admin_agent", grokBotAgentId: null, actorId: SPAM_SWEEP_ACTOR_ID };
  const created = await deps.createApproval({
    orgId: opsOrgId,
    employeeId: "",
    credentialId: "",
    title: "スパム疑いアカウントの停止（自動提案）",
    purpose: "admin.spam_suspend",
    summary: `日次スパムスイープ: ${finalPlan.eligibleCount} 組織のアカウント停止を提案します。承認者は指定運用者のみ。承認されるまで何も実行されません。`,
    risk: "high",
    tool: "accounts.suspend",
    jobId: `spam_sweep_${now.toISOString().slice(0, 10)}`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalClass: ADMIN_AUDIT_CLASS,
      auditAction: "admin.spam_suspend",
      always_human: true,
      adminTool: "accounts.suspend",
      isAdminMcpTool: true,
      adminMutation: { action: "suspend", orgIds: finalPlan.orgs.map((o) => o.orgId), reason, previewHash: finalPlan.previewHash },
      adminRequester: requester,
      spamSweepPlan: publicPlan(finalPlan),
    },
  });
  await deps.audit({
    orgId: opsOrgId,
    employeeId: null,
    credentialId: null,
    action: "admin.spam_suspend",
    purpose: "admin.spam_suspend",
    summary: `承認待ち: スパム疑いアカウントの停止（自動提案 ${finalPlan.eligibleCount} 組織）`,
    metadata: { approvalId: created.approval.id, auditClass: ADMIN_AUDIT_CLASS, always_human: true, proposedBy: SPAM_SWEEP_ACTOR_ID },
  });
  void Promise.resolve(deps.notify(created.approval)).catch(() => null);
  return { proposed: true, approvalId: created.approval.id, orgCount: finalPlan.eligibleCount };
}
