/**
 * P1 External Contract Card Portal Link Admin MCP Queue
 *
 * Queue portal link request for always_human approval.
 * After approval, mints the deep link → Stripe Customer Portal.
 *
 * CRITICAL SECURITY CONSTRAINTS:
 * - always_human approval required (not risk_based)
 * - Feature flag checked before queue
 * - Wire approval_id to audit trail
 *
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { sendApprovalNeededEmail } from "@/lib/email";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { appendAuditEvent, createApproval } from "@/lib/data";
import type { AdminRequester } from "@/lib/admin-mcp/self-approval";
import { checkExternalContractCardSetupFlag } from "./feature-flag";

const PORTAL_AUDIT_CLASS = "external_contract_card_portal";
const PORTAL_AUDIT_ACTION = "admin.card_portal_link_mint";

export type PortalLinkQueueResult =
  | {
      ok: false;
      code: "needs_approval";
      needs_approval: true;
      approvalId: string | null;
      statusToken: string | null;
      pollUrl: string | null;
      pollPath: string | null;
      pollHint: "continue_polling";
      title: string;
      summary: string;
      tool: string;
      always_human: true;
      auditClass: typeof PORTAL_AUDIT_CLASS;
      auditAction: typeof PORTAL_AUDIT_ACTION;
    }
  | {
      ok: false;
      code: "feature_disabled";
      error: string;
      messageJa: string;
      nextStepJa: string;
    };

/**
 * Queue a portal link mint request for always_human approval.
 *
 * This creates an approval ticket that, when approved, will trigger
 * the portal session creation via the fulfill handler.
 */
export async function queuePortalLinkMint(input: {
  cred: ResolvedAdminCredential;
  purpose: "change" | "delete";
  jobId?: string;
}): Promise<PortalLinkQueueResult> {
  const flagCheck = checkExternalContractCardSetupFlag();
  if (!flagCheck.enabled) {
    return {
      ok: false,
      code: "feature_disabled",
      error: flagCheck.error!.error,
      messageJa: flagCheck.error!.messageJa,
      nextStepJa: flagCheck.error!.nextStepJa,
    };
  }

  const purposeJa = input.purpose === "change" ? "変更" : "削除";
  const title = `支払い方法の${purposeJa}リンク発行`;
  const summary = `組織の外部契約用支払い方法を${purposeJa}するためのStripe Portalリンクを発行します。`;
  const tool = "cardSetup.mintPortalLink";

  const jobId =
    input.jobId ||
    `card_portal_${input.cred.orgId}_${Date.now().toString(36)}`;

  const requester: AdminRequester = {
    kind: "admin_agent",
    credentialGeneration: input.cred.generation,
    grokBotAgentId: input.cred.grokBotAgentId,
    actorId: input.cred.actorId,
  };

  const created = await createApproval({
    orgId: input.cred.orgId,
    employeeId: "",
    credentialId: "",
    title,
    purpose: PORTAL_AUDIT_ACTION,
    summary,
    risk: "high",
    tool,
    jobId,
    metadata: {
      auditClass: PORTAL_AUDIT_CLASS,
      auditAction: PORTAL_AUDIT_ACTION,
      always_human: true,
      adminTool: tool,
      adminMutation: { purpose: input.purpose },
      adminRequester: requester,
      portalLinkRequest: true,
      portalPurpose: input.purpose,
    },
  });

  await appendAuditEvent({
    orgId: input.cred.orgId,
    employeeId: null,
    credentialId: null,
    action: PORTAL_AUDIT_ACTION as Parameters<typeof appendAuditEvent>[0]["action"],
    purpose: PORTAL_AUDIT_ACTION,
    summary: `承認待ち: ${title}`,
    metadata: {
      approvalId: created.approval.id,
      tool,
      auditClass: PORTAL_AUDIT_CLASS,
      always_human: true,
      portalPurpose: input.purpose,
    },
  });

  const notifyTo =
    process.env.BILLING_NOTIFY_EMAIL ||
    process.env.APPROVAL_NOTIFY_EMAIL ||
    "owner@example.com";
  void sendApprovalNeededEmail(notifyTo, summary, "high").catch(() => null);
  void sendApprovalNotifications(created.approval, null).catch(() => null);

  return {
    ok: false,
    code: "needs_approval",
    needs_approval: true,
    approvalId: created.approval.id,
    statusToken: created.statusToken,
    pollUrl: created.pollUrl,
    pollPath: created.approval.pollPath,
    pollHint: "continue_polling",
    title,
    summary: created.approval.summary,
    tool,
    always_human: true,
    auditClass: PORTAL_AUDIT_CLASS,
    auditAction: PORTAL_AUDIT_ACTION,
  };
}

/**
 * Check if an approval is for portal link mint.
 */
export function isPortalLinkApproval(
  metadata: Record<string, unknown>
): boolean {
  return (
    metadata.auditClass === PORTAL_AUDIT_CLASS &&
    metadata.portalLinkRequest === true
  );
}
