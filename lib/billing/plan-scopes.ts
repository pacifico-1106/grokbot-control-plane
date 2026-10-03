/**
 * P1 Plan Rails — per-plan MCP allowlists and approval route templates.
 *
 * SOURCE OF TRUTH: This code defines which tools are available per plan.
 * Tenant modifications are NOT allowed. Tenants can only narrow (not widen) access.
 *
 * FEATURE FLAG: P1_PLAN_RAILS_ENABLED must be ON for plan filtering to apply.
 * When OFF, all tools remain available (existing behavior, byte-identical to pre-rails).
 *
 * PLAN KEYS:
 * - intern: Entry-level, ~1 business task (日報/議事録, 定型メール, FAQ一次返答案)
 * - proper: Mid-tier, ~3 business tasks (Intern + 見積/提案, 商談日程, フォローアップ)
 * - executive: Full capabilities (Proper + 高度権限設計, 監査ログ詳細, 開発保守)
 * - NULL: Legacy orgs — no filtering (preserve existing behavior)
 *
 * SECURITY INVARIANTS:
 * - Plans control tool availability, NOT approval requirements
 * - always_human tools (send/confirm/order) remain always_human regardless of plan
 * - Unknown plan, missing billing status, or errors → fail closed (no widening)
 * - Per-org overrides can only narrow, never widen plan scope
 */

import type { GatewayToolId } from "@/lib/gateway/tools";
import type { AdminMcpToolName } from "@/lib/mcp/admin-public";

/** Plan keys for AI社員 pricing tiers. NULL = legacy (no filtering). */
export type PlanKey = "intern" | "proper" | "executive";

/** All valid plan keys in upgrade order. */
export const PLAN_KEYS: readonly PlanKey[] = ["intern", "proper", "executive"] as const;

/** Plan hierarchy for upgrade/downgrade detection. Higher index = higher tier. */
export const PLAN_TIER_ORDER: Record<PlanKey, number> = {
  intern: 0,
  proper: 1,
  executive: 2,
};

/**
 * Stripe price lookup keys for plan resolution.
 * Format: staffpass_plan_{plan}_{interval}
 * NEVER hardcode amounts — always resolve by lookup_key.
 */
export const STRIPE_PRICE_LOOKUP_KEYS: Record<PlanKey, { monthly: string; yearly: string }> = {
  intern: {
    monthly: "staffpass_plan_intern_monthly",
    yearly: "staffpass_plan_intern_yearly",
  },
  proper: {
    monthly: "staffpass_plan_proper_monthly",
    yearly: "staffpass_plan_proper_yearly",
  },
  executive: {
    monthly: "staffpass_plan_executive_monthly",
    yearly: "staffpass_plan_executive_yearly",
  },
};

/**
 * Stripe product IDs for reference (live, JPY).
 * Used for plan validation, NOT for price resolution.
 */
export const STRIPE_PRODUCT_IDS: Record<PlanKey, string> = {
  intern: "prod_VMIoT9bpVDgzXL",
  proper: "prod_VMIoVllelHMMyh",
  executive: "prod_VMIo0WkobCbV7B",
};

/**
 * Gateway tools available per plan.
 *
 * DESIGN PRINCIPLE: Plans control AVAILABILITY, not approval requirements.
 * forceNeedsApproval / always_human from tools.ts always applies regardless of plan.
 *
 * Intern: Basic read/draft operations, FAQ, internal posting
 * Proper: Intern + confirm, send, commerce quote, external comms
 * Executive: Proper + write, browser, order, audit, external sharing
 */
export const PLAN_GATEWAY_SCOPES: Record<PlanKey, readonly GatewayToolId[]> = {
  intern: [
    "tools.ping",
    "tools.read",
    "calendar.read",
    "calendar.propose",
    "mail.draft",
    "files.read",
    "slack.post",
    "comm.reply",
    "knowledge.search",
    "approvals.request",
  ],
  proper: [
    // All intern scopes
    "tools.ping",
    "tools.read",
    "calendar.read",
    "calendar.propose",
    "mail.draft",
    "files.read",
    "slack.post",
    "comm.reply",
    "knowledge.search",
    "approvals.request",
    // Proper additions (always_human where marked in tools.ts)
    "calendar.confirm",
    "mail.send",
    "comm.send",
    "commerce.quote",
  ],
  executive: [
    // All proper scopes
    "tools.ping",
    "tools.read",
    "calendar.read",
    "calendar.propose",
    "mail.draft",
    "files.read",
    "slack.post",
    "comm.reply",
    "knowledge.search",
    "approvals.request",
    "calendar.confirm",
    "mail.send",
    "comm.send",
    "commerce.quote",
    // Executive additions (always_human where marked in tools.ts)
    "calendar.allowlist.patch",
    "files.write",
    "browser.use",
    "commerce.order",
    "slack.post_external",
    "drive.share_external",
    "sns.publish",
    "audit.append",
  ],
};

/**
 * Admin MCP tools available per plan.
 *
 * DESIGN PRINCIPLE:
 * - Read-only tools (*.get, *.list, *.status, *.inspect) are NOT plan-gated
 * - Only mutation tools (*.patch, *.upsert, etc.) are plan-gated
 * - orgs.create is operator-only (not in tenant self-setup)
 * - Intern includes LINE/Slack approval channel setup from launch
 *
 * SECURITY: operator-only tools (orgs.create) are excluded from all plan scopes.
 */
export const PLAN_ADMIN_SCOPES: Record<PlanKey, readonly AdminMcpToolName[]> = {
  intern: [
    // Basic setup
    "employees.issue",
    "employees.allowedAccounts.add",
    "employees.allowedAccounts.remove",
    "employees.allowedAccounts.list",
    "link",
    "roles.propose",
    // Approval channels (Intern includes LINE from launch)
    "setup.slackStatus",
    "setup.slackAdapter.setBotToken",
    "setup.lineApprovalStatus",
    "setup.lineApproval.upsert",
    "setup.lineApproval.setEmployeeInbox",
    "setup.lineApproval.demoteTelegram",
    "setup.approverBindingStatus",
    "setup.slackDmApprovalStatus",
    "dmAutoroute.list",
    "dmAutoroute.run",
    "setup.approvalDelivery.autoResolve",
    "approvalWorkflow.get",
    "approvalWorkflow.bindVoter",
    "approvalWorkflow.unbindVoter",
    "approvalWorkflow.resendVoterVerification",
    "approvalWorkflow.listVoterBindings",
    "approvalWorkflow.inspect",
    "approvalWorkflow.remind",
    "channels.classify",
    // Read-only (not gated but included for completeness)
    "setup.connectInternalBase",
    "ingressHandoff.get",
    "schedulingPolicy.get",
    "replyPolicy.get",
    "mailPolicy.get",
    "internalAudienceRule.get",
    "stuckWatch.get",
    "stuckWatch.list",
    "stuckWatch.inspect",
    "approvalRoutes.get",
    "orgs.status",
    "employeeIdentity.status",
    // Org management (always_human)
    "orgs.patch",
    "orgs.issueAdminCredential",
    "approvals.proxyResolve",
  ],
  proper: [
    // All intern scopes
    "employees.issue",
    "employees.allowedAccounts.add",
    "employees.allowedAccounts.remove",
    "employees.allowedAccounts.list",
    "link",
    "roles.propose",
    "setup.slackStatus",
    "setup.slackAdapter.setBotToken",
    "setup.lineApprovalStatus",
    "setup.lineApproval.upsert",
    "setup.lineApproval.setEmployeeInbox",
    "setup.lineApproval.demoteTelegram",
    "setup.approverBindingStatus",
    "setup.slackDmApprovalStatus",
    "dmAutoroute.list",
    "dmAutoroute.run",
    "setup.approvalDelivery.autoResolve",
    "approvalWorkflow.get",
    "approvalWorkflow.bindVoter",
    "approvalWorkflow.unbindVoter",
    "approvalWorkflow.resendVoterVerification",
    "approvalWorkflow.listVoterBindings",
    "approvalWorkflow.inspect",
    "approvalWorkflow.remind",
    "channels.classify",
    "setup.connectInternalBase",
    "ingressHandoff.get",
    "schedulingPolicy.get",
    "replyPolicy.get",
    "mailPolicy.get",
    "internalAudienceRule.get",
    "stuckWatch.get",
    "stuckWatch.list",
    "stuckWatch.inspect",
    "approvalRoutes.get",
    "orgs.status",
    "employeeIdentity.status",
    "orgs.patch",
    "orgs.issueAdminCredential",
    "approvals.proxyResolve",
    // Proper additions: policy changes
    "policy.patch",
    "parties.upsert",
    "approvalWorkflow.patch",
    "schedulingPolicy.patch",
    "replyPolicy.patch",
    "mailPolicy.patch",
    "internalAudienceRule.patch",
    "approvalRoutes.patch",
  ],
  executive: [
    // All proper scopes
    "employees.issue",
    "employees.allowedAccounts.add",
    "employees.allowedAccounts.remove",
    "employees.allowedAccounts.list",
    "link",
    "roles.propose",
    "setup.slackStatus",
    "setup.slackAdapter.setBotToken",
    "setup.lineApprovalStatus",
    "setup.lineApproval.upsert",
    "setup.lineApproval.setEmployeeInbox",
    "setup.lineApproval.demoteTelegram",
    "setup.approverBindingStatus",
    "setup.slackDmApprovalStatus",
    "dmAutoroute.list",
    "dmAutoroute.run",
    "setup.approvalDelivery.autoResolve",
    "approvalWorkflow.get",
    "approvalWorkflow.bindVoter",
    "approvalWorkflow.unbindVoter",
    "approvalWorkflow.resendVoterVerification",
    "approvalWorkflow.listVoterBindings",
    "approvalWorkflow.inspect",
    "approvalWorkflow.remind",
    "channels.classify",
    "setup.connectInternalBase",
    "ingressHandoff.get",
    "schedulingPolicy.get",
    "replyPolicy.get",
    "mailPolicy.get",
    "internalAudienceRule.get",
    "stuckWatch.get",
    "stuckWatch.list",
    "stuckWatch.inspect",
    "approvalRoutes.get",
    "orgs.status",
    "employeeIdentity.status",
    "orgs.patch",
    "orgs.issueAdminCredential",
    "approvals.proxyResolve",
    "policy.patch",
    "parties.upsert",
    "approvalWorkflow.patch",
    "schedulingPolicy.patch",
    "replyPolicy.patch",
    "mailPolicy.patch",
    "internalAudienceRule.patch",
    "approvalRoutes.patch",
    // Executive additions: advanced operations
    "ingressHandoff.patch",
    "stuckWatch.patch",
    "stuckWatch.retry",
    "stuckWatch.resolve",
    "stuckWatch.classify",
    "employeeIdentity.upsert",
    "employeeIdentity.bindMailbox",
  ],
};

/**
 * Read-only admin tools that are NOT plan-gated.
 * These are always available regardless of plan.
 */
export const READ_ONLY_ADMIN_TOOLS: readonly AdminMcpToolName[] = [
  "setup.slackStatus",
  "employees.allowedAccounts.list",
  "setup.slackDmApprovalStatus",
  "dmAutoroute.list",
  "setup.lineApprovalStatus",
  "setup.approverBindingStatus",
  "setup.connectInternalBase",
  "approvalWorkflow.get",
  "approvalWorkflow.inspect",
  "approvalWorkflow.listVoterBindings",
  "ingressHandoff.get",
  "schedulingPolicy.get",
  "replyPolicy.get",
  "mailPolicy.get",
  "internalAudienceRule.get",
  "stuckWatch.get",
  "stuckWatch.list",
  "stuckWatch.inspect",
  "approvalRoutes.get",
  "orgs.status",
  "employeeIdentity.status",
];

/**
 * Check if a plan key is valid.
 */
export function isValidPlanKey(key: string | null | undefined): key is PlanKey {
  if (!key) return false;
  return PLAN_KEYS.includes(key as PlanKey);
}

/**
 * Compare two plans. Returns:
 * - negative if a < b (downgrade)
 * - 0 if a === b
 * - positive if a > b (upgrade)
 *
 * NULL plans are treated as having all access (legacy), so:
 * - NULL → any plan = downgrade (narrowing)
 * - any plan → NULL = invalid (not allowed)
 */
export function comparePlans(
  a: PlanKey | null | undefined,
  b: PlanKey | null | undefined
): number {
  const tierA = a ? PLAN_TIER_ORDER[a] : Infinity;
  const tierB = b ? PLAN_TIER_ORDER[b] : Infinity;
  return tierA - tierB;
}

/**
 * Check if moving from oldPlan to newPlan is an upgrade.
 */
export function isPlanUpgrade(
  oldPlan: PlanKey | null | undefined,
  newPlan: PlanKey | null | undefined
): boolean {
  return comparePlans(newPlan, oldPlan) > 0;
}

/**
 * Check if moving from oldPlan to newPlan is a downgrade.
 */
export function isPlanDowngrade(
  oldPlan: PlanKey | null | undefined,
  newPlan: PlanKey | null | undefined
): boolean {
  return comparePlans(newPlan, oldPlan) < 0;
}

/**
 * Check if a gateway tool is available for a plan.
 * NULL plan = legacy (all tools available).
 * Unknown/invalid plan = fail closed (no tools).
 */
export function isGatewayToolAvailableForPlan(
  toolId: GatewayToolId | string,
  planKey: PlanKey | null | undefined
): boolean {
  if (planKey === null || planKey === undefined) {
    return true;
  }
  if (!isValidPlanKey(planKey)) {
    return false;
  }
  const scopes = PLAN_GATEWAY_SCOPES[planKey];
  return scopes.includes(toolId as GatewayToolId);
}

/**
 * Check if an admin MCP tool is available for a plan.
 * NULL plan = legacy (all tools available).
 * Unknown/invalid plan = fail closed (no tools).
 * Read-only tools are always available regardless of plan.
 */
export function isAdminToolAvailableForPlan(
  toolName: AdminMcpToolName | string,
  planKey: PlanKey | null | undefined
): boolean {
  if (READ_ONLY_ADMIN_TOOLS.includes(toolName as AdminMcpToolName)) {
    return true;
  }
  if (planKey === null || planKey === undefined) {
    return true;
  }
  if (!isValidPlanKey(planKey)) {
    return false;
  }
  const scopes = PLAN_ADMIN_SCOPES[planKey];
  return scopes.includes(toolName as AdminMcpToolName);
}

/**
 * Get gateway tools that would be revoked when downgrading from oldPlan to newPlan.
 * Used for pending approval cancellation and scope audit.
 */
export function getRevokedGatewayTools(
  oldPlan: PlanKey | null | undefined,
  newPlan: PlanKey | null | undefined
): GatewayToolId[] {
  const oldScopes: readonly GatewayToolId[] = oldPlan
    ? PLAN_GATEWAY_SCOPES[oldPlan] ?? []
    : Object.values(PLAN_GATEWAY_SCOPES).flat();
  const newScopes: readonly GatewayToolId[] = newPlan
    ? PLAN_GATEWAY_SCOPES[newPlan] ?? []
    : [];

  const newSet = new Set(newScopes);
  return (oldScopes as GatewayToolId[]).filter((t) => !newSet.has(t));
}

/**
 * Get admin tools that would be revoked when downgrading from oldPlan to newPlan.
 */
export function getRevokedAdminTools(
  oldPlan: PlanKey | null | undefined,
  newPlan: PlanKey | null | undefined
): AdminMcpToolName[] {
  const oldScopes: readonly AdminMcpToolName[] = oldPlan
    ? PLAN_ADMIN_SCOPES[oldPlan] ?? []
    : Object.values(PLAN_ADMIN_SCOPES).flat();
  const newScopes: readonly AdminMcpToolName[] = newPlan
    ? PLAN_ADMIN_SCOPES[newPlan] ?? []
    : [];

  const newSet = new Set(newScopes);
  const readOnlySet = new Set(READ_ONLY_ADMIN_TOOLS);
  return (oldScopes as AdminMcpToolName[]).filter(
    (t) => !newSet.has(t) && !readOnlySet.has(t)
  );
}

/**
 * Get gateway tools added when upgrading from oldPlan to newPlan.
 */
export function getAddedGatewayTools(
  oldPlan: PlanKey | null | undefined,
  newPlan: PlanKey | null | undefined
): GatewayToolId[] {
  const oldScopes: readonly GatewayToolId[] = oldPlan
    ? PLAN_GATEWAY_SCOPES[oldPlan] ?? []
    : [];
  const newScopes: readonly GatewayToolId[] = newPlan
    ? PLAN_GATEWAY_SCOPES[newPlan] ?? []
    : Object.values(PLAN_GATEWAY_SCOPES).flat();

  const oldSet = new Set(oldScopes);
  return (newScopes as GatewayToolId[]).filter((t) => !oldSet.has(t));
}

/**
 * Plan display information for UI.
 */
export interface PlanDisplayInfo {
  key: PlanKey;
  nameJa: string;
  descriptionJa: string;
  businessCapacity: string;
}

export const PLAN_DISPLAY_INFO: Record<PlanKey, PlanDisplayInfo> = {
  intern: {
    key: "intern",
    nameJa: "Intern",
    descriptionJa: "定型・一般事務（日報/議事録下書き、定型メール下書き、社内案内下書き、予定空き確認、FAQ一次返答案）",
    businessCapacity: "≈1業務",
  },
  proper: {
    key: "proper",
    nameJa: "Proper",
    descriptionJa: "営業・顧客対応（Intern全て＋問い合わせ一次返信下書き、見積/提案メモ、商談日程候補、対応ログ要約、フォローアップリマインド）",
    businessCapacity: "≈3業務",
  },
  executive: {
    key: "executive",
    nameJa: "Executive",
    descriptionJa: "経営補佐・開発保守（Proper全て＋高度な権限設計、高度な承認ルール運用、監査ログ詳細出力、開発・保守）",
    businessCapacity: "高度運用",
  },
};

/**
 * Resolve plan key from Stripe price lookup_key.
 * Returns null if lookup_key doesn't match any known plan.
 */
export function resolvePlanKeyFromLookupKey(
  lookupKey: string | null | undefined
): PlanKey | null {
  if (!lookupKey) return null;
  for (const [plan, keys] of Object.entries(STRIPE_PRICE_LOOKUP_KEYS)) {
    if (lookupKey === keys.monthly || lookupKey === keys.yearly) {
      return plan as PlanKey;
    }
  }
  return null;
}

/**
 * Resolve plan key from Stripe product ID.
 * Returns null if product ID doesn't match any known plan.
 */
export function resolvePlanKeyFromProductId(
  productId: string | null | undefined
): PlanKey | null {
  if (!productId) return null;
  for (const [plan, id] of Object.entries(STRIPE_PRODUCT_IDS)) {
    if (productId === id) {
      return plan as PlanKey;
    }
  }
  return null;
}
