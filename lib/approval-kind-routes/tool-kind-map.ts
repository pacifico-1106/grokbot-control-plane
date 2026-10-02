/**
 * P1 Approval Kind Routes — Tool to Kind Mapping
 *
 * SECURITY: This mapping is FIXED IN CODE and cannot be changed by tenants.
 * Unmapped tools default to 'other' (fail-closed).
 *
 * The mapping determines which approval route applies to each tool.
 */

import type { ApprovalKind } from "./types";

/**
 * Fixed tool→kind mapping (internal, mutable for Object.freeze).
 */
const _toolKindMap: Record<string, ApprovalKind> = {
  // Post kind: chat/messaging
  "slack.post": "post",
  "comm.reply": "post",
  "comm.send": "post",
  "sns.publish": "post",

  // Mail kind: email operations
  "mail.send": "mail",
  "mail.draft": "mail",

  // Account kind: admin operations (from audit-class.ts ADMIN_TOOL_AUDIT_ACTION)
  "employees.issue": "account",
  "link": "account",
  "policy.patch": "account",
  "parties.upsert": "account",
  "channels.classify": "account",
  "roles.propose": "account",
  "ingressHandoff.patch": "account",
  "schedulingPolicy.patch": "account",
  "replyPolicy.patch": "account",
  "mailPolicy.patch": "account",
  "stuckWatch.patch": "account",
  "setup.slackAdapter.setBotToken": "account",
  "setup.lineApproval.upsert": "account",
  "setup.lineApproval.setEmployeeInbox": "account",
  "setup.lineApproval.demoteTelegram": "account",
  "orgs.create": "account",
  "orgs.issueAdminCredential": "account",
  "orgs.patch": "account",
  "approvalWorkflow.patch": "account",
  "internalAudienceRule.patch": "account",
  "approvalWorkflow.remind": "account",
  "approvalWorkflow.bindVoter": "account",
  "approvalWorkflow.unbindVoter": "account",
  "approvals.proxyResolve": "account",
  "employeeIdentity.upsert": "account",
  "employeeIdentity.bindMailbox": "account",
  "approvalRoutes.patch": "account",
  "channelScope.patch": "account",
  "channelScope.reconcile": "account",

  // Decision kind: decision workflow
  "decision.request": "decision",
};

/**
 * Fixed tool→kind mapping.
 *
 * Categories:
 * - post: Chat posting, replies (slack.post, comm.reply, comm.send)
 * - mail: Email sending (mail.send, mail.draft)
 * - account: Admin/account operations (employees.issue, link, policy.patch, etc.)
 * - decision: Decision requests (decision.request)
 * - other: All unmapped tools
 *
 * SECURITY: This object is FROZEN and cannot be modified at runtime.
 * NEVER allow tenants to modify this mapping.
 */
export const TOOL_KIND_MAP: Readonly<Record<string, ApprovalKind>> = Object.freeze(_toolKindMap);

/**
 * Get the approval kind for a tool.
 * Unmapped tools return 'other' (fail-closed default).
 *
 * @param tool - Tool name from the approval request
 * @returns The approval kind for routing
 */
export function getToolApprovalKind(tool: string | null | undefined): ApprovalKind {
  const t = (tool || "").trim();
  if (!t) return "other";

  // Direct mapping
  if (t in TOOL_KIND_MAP) {
    return TOOL_KIND_MAP[t];
  }

  // Prefix-based mapping for admin tools
  const adminPrefixes = [
    "admin.",
    "setup.",
    "orgs.",
    "internalAudienceRule.",
    "approvalWorkflow.",
    "approvalRoutes.",
    "channelScope.",
    "ingressHandoff.",
    "schedulingPolicy.",
    "replyPolicy.",
    "mailPolicy.",
    "stuckWatch.",
    "approvals.",
    "employeeIdentity.",
  ];
  for (const prefix of adminPrefixes) {
    if (t.startsWith(prefix)) {
      return "account";
    }
  }

  // Default to 'other' for unmapped tools
  return "other";
}

/**
 * Check if a tool is in the account kind.
 * Used for enforcing owner/admin-only approvers.
 */
export function isAccountKindTool(tool: string | null | undefined): boolean {
  return getToolApprovalKind(tool) === "account";
}

/**
 * Get all tools mapped to a specific kind.
 * Useful for documentation and testing.
 */
export function getToolsForKind(kind: ApprovalKind): string[] {
  return Object.entries(TOOL_KIND_MAP)
    .filter(([, k]) => k === kind)
    .map(([tool]) => tool);
}
