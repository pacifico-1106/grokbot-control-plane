/**
 * P1 External Contract Card Setup Admin MCP Queue
 *
 * Queue card setup request for always_human approval.
 * After approval, mints the deep link → Stripe Checkout session mode=setup.
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

const CARD_SETUP_AUDIT_CLASS = "external_contract_card_setup";
const CARD_SETUP_AUDIT_ACTION = "admin.card_setup_link_mint";

export type CardSetupQueueResult =
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
      auditClass: typeof CARD_SETUP_AUDIT_CLASS;
      auditAction: typeof CARD_SETUP_AUDIT_ACTION;
    }
  | {
      ok: false;
      code: "feature_disabled";
      error: string;
      messageJa: string;
      nextStepJa: string;
    };

/**
 * Queue a card setup link mint request for always_human approval.
 *
 * This creates an approval ticket that, when approved, will trigger
 * the card setup session creation via the fulfill handler.
 */
export async function queueCardSetupLinkMint(input: {
  cred: ResolvedAdminCredential;
  jobId?: string;
}): Promise<CardSetupQueueResult> {
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

  const title = "外部契約カード登録リンクの発行";
  const summary = `組織の外部契約用支払い方法を登録するためのStripe Checkoutリンクを発行します。リンクは15分で期限切れになります。`;
  const tool = "cardSetup.mintLink";

  const jobId =
    input.jobId || `card_setup_${input.cred.orgId}_${Date.now().toString(36)}`;

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
    purpose: CARD_SETUP_AUDIT_ACTION,
    summary,
    risk: "high",
    tool,
    jobId,
    metadata: {
      auditClass: CARD_SETUP_AUDIT_CLASS,
      auditAction: CARD_SETUP_AUDIT_ACTION,
      always_human: true,
      adminTool: tool,
      adminMutation: {},
      adminRequester: requester,
      cardSetupRequest: true,
    },
  });

  await appendAuditEvent({
    orgId: input.cred.orgId,
    employeeId: null,
    credentialId: null,
    action: CARD_SETUP_AUDIT_ACTION as Parameters<typeof appendAuditEvent>[0]["action"],
    purpose: CARD_SETUP_AUDIT_ACTION,
    summary: `承認待ち: ${title}`,
    metadata: {
      approvalId: created.approval.id,
      tool,
      auditClass: CARD_SETUP_AUDIT_CLASS,
      always_human: true,
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
    auditClass: CARD_SETUP_AUDIT_CLASS,
    auditAction: CARD_SETUP_AUDIT_ACTION,
  };
}

/**
 * Check if an approval is for card setup link mint.
 */
export function isCardSetupApproval(
  metadata: Record<string, unknown>
): boolean {
  return (
    metadata.auditClass === CARD_SETUP_AUDIT_CLASS &&
    metadata.cardSetupRequest === true
  );
}
