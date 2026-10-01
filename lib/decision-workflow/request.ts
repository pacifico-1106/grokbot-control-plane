/**
 * P1 Decision Workflow — Request Handler
 *
 * Handles decision.request for Employee MCP.
 * Implements tier determination, tax-excluded threshold, deputy, fiscal year.
 *
 * Security:
 * - AI cannot be approver (validated by approval-kind-routes/engine)
 * - Self-approval forbidden (requester's vote never counts)
 * - T2 has 72h deadline with fail_closed
 * - T3 requires all approval
 */

import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import { isDecisionWorkflowEnabled } from "@/lib/feature-flags";
import { getEffectiveApprovalKindRoute } from "@/lib/approval-kind-routes/data";
import { getOrgApprovalKindRoutesPolicy } from "@/lib/approval-kind-routes/data";
import type { DecisionTier, DecisionTierRoute, DecisionWorkflowConfig, TierRoutingRule } from "@/lib/approval-kind-routes/types";
import { createApproval } from "@/lib/data/approvals";
import { appendAuditEvent } from "@/lib/data/audit";
import { sendDecisionVotingCard } from "./notify";
import {
  CONSUMPTION_TAX_RATE,
  T3_AUTO_ESCALATION_KEYWORDS,
  type DecisionRequestInput,
  type DecisionRequestResult,
  type DecisionRequestValidation,
  type FiscalYearInfo,
} from "./types";
import { DEFAULT_CONSUMPTION_TAX_RATE } from "@/lib/approval-kind-routes/presets";

/**
 * Calculate tax-excluded amount from tax-included amount.
 * @param amountJpy - The amount in JPY
 * @param taxIncluded - Whether the amount includes tax (default true)
 * @param taxRate - The consumption tax rate (default from config or 0.10)
 */
export function calculateTaxExcludedAmount(
  amountJpy: number,
  taxIncluded = true,
  taxRate: number = DEFAULT_CONSUMPTION_TAX_RATE
): number {
  if (!taxIncluded) return amountJpy;
  return Math.floor(amountJpy / (1 + taxRate));
}

/**
 * Calculate fiscal year info based on config.
 */
export function calculateFiscalYear(
  date: Date,
  config: DecisionWorkflowConfig
): FiscalYearInfo {
  const startMonth = config.fiscalYearStartMonth || 4;
  const startDay = config.fiscalYearStartDay || 1;

  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  let fiscalYearStart: number;
  if (month > startMonth || (month === startMonth && day >= startDay)) {
    fiscalYearStart = year;
  } else {
    fiscalYearStart = year - 1;
  }

  const startDate = new Date(fiscalYearStart, startMonth - 1, startDay);
  const endDate = new Date(fiscalYearStart + 1, startMonth - 1, startDay - 1);

  const fiscalYear = `FY${fiscalYearStart}`;

  return {
    fiscalYear,
    startDate,
    endDate,
    isCurrentFiscalYear: date >= startDate && date <= endDate,
  };
}

/**
 * Check if text contains any of the given keywords (case-insensitive substring match).
 */
export function containsKeywords(text: string, keywords: readonly string[]): string[] {
  const normalized = text.toLowerCase();
  return keywords.filter((keyword) =>
    normalized.includes(keyword.toLowerCase())
  );
}

/**
 * Check if title/description contains T3 auto-escalation keywords.
 * @deprecated Use tier routing rules from config instead.
 */
export function containsT3Keywords(text: string): boolean {
  return containsKeywords(text, T3_AUTO_ESCALATION_KEYWORDS).length > 0;
}

/**
 * Build tier order map from config.
 * Uses tier.rank if available, otherwise falls back to index.
 */
function buildTierOrder(config: DecisionWorkflowConfig | null): Record<string, number> {
  if (!config?.tiers) {
    // Legacy fallback
    return { T1: 1, T2: 2, T3: 3 };
  }

  const orderMap: Record<string, number> = {};
  const tiersWithRank = config.tiers.map((t, i) => ({
    tier: t.tier,
    rank: t.rank ?? i,
  }));

  // Sort by rank
  tiersWithRank.sort((a, b) => a.rank - b.rank);

  // Assign order based on sorted position
  tiersWithRank.forEach((t, i) => {
    orderMap[t.tier] = i + 1;
  });

  return orderMap;
}

/**
 * Get the default tier from config.
 */
function getDefaultTier(config: DecisionWorkflowConfig | null): DecisionTier {
  if (!config?.tiers || config.tiers.length === 0) {
    return "T1";
  }

  if (config.defaultTierId) {
    return config.defaultTierId;
  }

  // Use the tier with lowest rank (or first if no ranks)
  const sortedTiers = [...config.tiers].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return sortedTiers[0].tier;
}

/**
 * Check if a tier routing rule matches the input.
 */
function matchesTierRule(
  rule: TierRoutingRule,
  input: DecisionRequestInput,
  taxExcludedAmount: number
): { matches: boolean; reason?: string } {
  const match = rule.match;
  const textToCheck = `${input.title} ${input.description} ${input.category ?? ""}`;

  // Check keywords (any match)
  if (match.keywords && match.keywords.length > 0) {
    const matchedKeywords = containsKeywords(textToCheck, match.keywords);
    if (matchedKeywords.length > 0) {
      return {
        matches: true,
        reason: `KEYWORD_MATCH: ${matchedKeywords.join(", ")}`,
      };
    }
  }

  // Check minAmountJpy
  if (match.minAmountJpy !== undefined && match.minAmountJpy !== null) {
    if (taxExcludedAmount >= match.minAmountJpy) {
      return {
        matches: true,
        reason: `AMOUNT_THRESHOLD: ${taxExcludedAmount.toLocaleString()}円(税抜) >= ${match.minAmountJpy.toLocaleString()}円`,
      };
    }
  }

  // Check categories
  if (match.categories && match.categories.length > 0 && input.category) {
    if (match.categories.includes(input.category)) {
      return {
        matches: true,
        reason: `CATEGORY_MATCH: ${input.category}`,
      };
    }
  }

  return { matches: false };
}

/**
 * Determine decision tier using routing rules.
 */
function determineTierByRouting(
  input: DecisionRequestInput,
  config: DecisionWorkflowConfig,
  taxExcludedAmount: number
): { tier: DecisionTier; reason: string } | null {
  if (!config.tierRouting || config.tierRouting.length === 0) {
    return null;
  }

  for (const rule of config.tierRouting) {
    const result = matchesTierRule(rule, input, taxExcludedAmount);
    if (result.matches) {
      return {
        tier: rule.tierId,
        reason: result.reason ?? `ROUTING_RULE: ${rule.tierId}`,
      };
    }
  }

  return null;
}

/**
 * Determine decision tier using legacy rules (deprecated).
 * Used when no tier routing rules are configured.
 */
function determineTierByLegacyRules(
  input: DecisionRequestInput,
  config: DecisionWorkflowConfig | null,
  taxExcludedAmount: number
): { tier: DecisionTier; reason: string } {
  const threshold = config?.amountThresholdJpy ?? 500000;
  const textToCheck = `${input.title} ${input.description} ${input.category ?? ""}`;

  // T3: keywords (deprecated hardcoded list)
  if (containsT3Keywords(textToCheck)) {
    return {
      tier: "T3",
      reason: "T3_KEYWORD_MATCH (legacy)",
    };
  }

  // T2: amount threshold
  if (taxExcludedAmount >= threshold) {
    return {
      tier: "T2",
      reason: `T2_AMOUNT_THRESHOLD: ${taxExcludedAmount.toLocaleString()}円(税抜) >= ${threshold.toLocaleString()}円`,
    };
  }

  // Default: T1
  return {
    tier: "T1",
    reason: "T1_DEFAULT",
  };
}

/**
 * Determine decision tier based on amount, category, and keywords.
 *
 * If config has tierRouting rules, they are used.
 * Otherwise, falls back to legacy rules (T3 keywords, T2 amount threshold).
 *
 * Requested tier can upgrade but not downgrade (unless by owner).
 */
export function determineDecisionTier(
  input: DecisionRequestInput,
  config: DecisionWorkflowConfig | null,
  isOwner = false
): { tier: DecisionTier; reason: string } {
  const amountJpy = input.amountJpy ?? 0;
  const taxRate = config?.consumptionTaxRate ?? DEFAULT_CONSUMPTION_TAX_RATE;
  const taxExcluded = calculateTaxExcludedAmount(amountJpy, input.taxIncluded ?? true, taxRate);

  // Try tier routing rules first
  let routingResult = config?.tierRouting
    ? determineTierByRouting(input, config, taxExcluded)
    : null;

  // Fall back to legacy rules
  if (!routingResult) {
    routingResult = determineTierByLegacyRules(input, config, taxExcluded);
  }

  const tierOrder = buildTierOrder(config);
  const requiredTier = routingResult.tier;
  const requiredReason = routingResult.reason;
  const requiredOrder = tierOrder[requiredTier] ?? 0;

  // Handle requested tier (upgrade only, unless owner)
  const requestedTier = input.requestedTier;
  if (requestedTier) {
    const requestedOrder = tierOrder[requestedTier] ?? 0;

    if (requestedOrder > requiredOrder) {
      return {
        tier: requestedTier,
        reason: `REQUESTED_UPGRADE_TO_${requestedTier}`,
      };
    }

    if (requestedOrder < requiredOrder && isOwner) {
      return {
        tier: requestedTier,
        reason: `OWNER_DOWNGRADE_TO_${requestedTier}`,
      };
    }
  }

  return {
    tier: requiredTier,
    reason: requiredReason,
  };
}

/**
 * Validate decision request input.
 */
export function validateDecisionRequest(
  input: DecisionRequestInput,
  config: DecisionWorkflowConfig | null,
  isOwner = false
): DecisionRequestValidation {
  const errors: string[] = [];

  if (!input.title || input.title.trim().length === 0) {
    errors.push("title_required");
  }

  if (!input.description || input.description.trim().length === 0) {
    errors.push("description_required");
  }

  if (!input.purpose || input.purpose.trim().length === 0) {
    errors.push("purpose_required");
  }

  if (!input.jobId || input.jobId.trim().length === 0) {
    errors.push("jobId_required");
  }

  if (input.amountJpy !== undefined && input.amountJpy !== null) {
    if (typeof input.amountJpy !== "number" || !Number.isFinite(input.amountJpy)) {
      errors.push("amountJpy_invalid");
    } else if (input.amountJpy < 0) {
      errors.push("amountJpy_negative");
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const { tier, reason } = determineDecisionTier(input, config, isOwner);
  const taxRate = config?.consumptionTaxRate ?? DEFAULT_CONSUMPTION_TAX_RATE;
  const taxExcludedAmountJpy = input.amountJpy
    ? calculateTaxExcludedAmount(input.amountJpy, input.taxIncluded ?? true, taxRate)
    : undefined;
  const fiscalYear = config
    ? calculateFiscalYear(new Date(), config).fiscalYear
    : undefined;

  return {
    ok: true,
    resolvedTier: tier,
    tierReason: reason,
    taxExcludedAmountJpy,
    fiscalYear,
  };
}

/**
 * Get tier route from decision workflow config.
 */
export function getTierRoute(
  tier: DecisionTier,
  config: DecisionWorkflowConfig | null
): DecisionTierRoute | null {
  if (!config || !config.tiers) return null;
  return config.tiers.find((t) => t.tier === tier) ?? null;
}

/**
 * Handle decision.request from Employee MCP.
 *
 * Creates an approval ticket for the decision with appropriate tier.
 * Sends voting cards to notification channels after approval creation.
 */
export async function handleDecisionRequest(
  cred: ResolvedEmployeeCredential,
  input: DecisionRequestInput
): Promise<DecisionRequestResult> {
  if (!isDecisionWorkflowEnabled()) {
    return {
      ok: false,
      code: "decision_workflow_disabled",
      message: "P1_DECISION_WORKFLOW_ENABLED is OFF",
    };
  }

  const orgId = cred.orgId;
  if (!orgId) {
    return {
      ok: false,
      code: "org_required",
      message: "orgId missing on credential (fail-closed)",
    };
  }

  const orgPolicy = await getOrgApprovalKindRoutesPolicy(orgId);
  const config = orgPolicy?.decisionWorkflow ?? null;

  const isOwner = false;

  const validation = validateDecisionRequest(input, config, isOwner);
  if (!validation.ok) {
    return {
      ok: false,
      code: "validation_failed",
      message: `Validation failed: ${validation.errors?.join(", ")}`,
    };
  }

  const tier = validation.resolvedTier!;
  const tierRoute = getTierRoute(tier, config);

  const effectiveDecisionRoute = await getEffectiveApprovalKindRoute(
    orgId,
    "decision",
    cred.employeeId
  );

  const deputyUserId = input.deputyUserId ?? config?.deputyUserId ?? null;

  const summary = buildDecisionSummary(input, tier, validation);

  const now = new Date();
  // Use deadlineHours from tier route config; no hardcoded tier-specific values
  const deadlineAt = tierRoute?.deadlineHours
    ? new Date(now.getTime() + tierRoute.deadlineHours * 60 * 60 * 1000)
    : null;

  const approverUserIds = tierRoute?.approverUserIds ?? effectiveDecisionRoute?.route?.approverUserIds ?? [];
  const quorum = tierRoute?.quorum ?? effectiveDecisionRoute?.route?.quorum ?? { type: "any" as const };

  const decisionMetadata: Record<string, unknown> = {
    type: "decision_request",
    tier,
    tierReason: validation.tierReason,
    amountJpy: input.amountJpy ?? null,
    taxExcludedAmountJpy: validation.taxExcludedAmountJpy ?? null,
    taxIncluded: input.taxIncluded ?? true,
    category: input.category ?? null,
    fiscalYear: validation.fiscalYear ?? null,
    deputyUserId,
    deadlineAt: deadlineAt?.toISOString() ?? null,
    approverUserIds,
    quorumRequired: quorum.type === "all" ? "all" : quorum.type === "count" ? quorum.n : 1,
    totalVoters: approverUserIds.length,
    approvedCount: 0,
    rejectedCount: 0,
    votes: [],
    attachments: input.attachments ?? [],
  };

  let approvalResult;
  try {
    approvalResult = await createApproval({
      orgId,
      employeeId: cred.employeeId,
      credentialId: cred.credentialId ?? "",
      title: input.title,
      purpose: input.purpose,
      summary,
      risk: tier === "T3" ? "high" : tier === "T2" ? "medium" : "low",
      tool: "decision.request",
      jobId: input.jobId,
      metadata: decisionMetadata,
    });
  } catch (error) {
    return {
      ok: false,
      code: "approval_creation_failed",
      message: error instanceof Error ? error.message : "Failed to create approval",
    };
  }

  await appendAuditEvent({
    orgId,
    employeeId: cred.employeeId,
    credentialId: cred.credentialId ?? "",
    action: "decision.requested",
    purpose: input.purpose,
    summary: `決裁依頼: ${tier} ${input.title}`,
    metadata: {
      approvalId: approvalResult.approval.id,
      tier,
      tierReason: validation.tierReason,
      amountJpy: input.amountJpy ?? null,
      fiscalYear: validation.fiscalYear ?? null,
      deadlineAt: deadlineAt?.toISOString() ?? null,
    },
  });

  const votingCardResults = await sendDecisionVotingCard(approvalResult.approval);
  const votingCardFailed = votingCardResults.some((r) => !r.ok);

  if (votingCardFailed) {
    await appendAuditEvent({
      orgId,
      employeeId: cred.employeeId,
      credentialId: cred.credentialId ?? "",
      action: "notification.delivery_failed",
      purpose: input.purpose,
      summary: "決裁投票カードの配信に一部失敗（決裁依頼は pending のまま継続）",
      metadata: {
        approvalId: approvalResult.approval.id,
        tier,
        results: votingCardResults,
      },
    });
  }

  return {
    ok: true,
    code: "needs_approval",
    approvalId: approvalResult.approval.id,
    statusToken: approvalResult.statusToken,
    pollUrl: approvalResult.pollUrl,
    tier,
    tierReason: validation.tierReason,
    title: input.title,
    summary,
    fiscalYear: validation.fiscalYear,
    deputyUserId,
    pollHint: "continue_polling",
    message: `決裁依頼を作成しました。Tier: ${tier}${tierRoute ? ` (${tierRoute.nameJa})` : ""}`,
  };
}

/**
 * Build decision summary text.
 */
function buildDecisionSummary(
  input: DecisionRequestInput,
  tier: DecisionTier,
  validation: DecisionRequestValidation
): string {
  const parts: string[] = [];

  parts.push(`【${tier}】${input.title}`);

  if (input.amountJpy) {
    const taxLabel = input.taxIncluded === false ? "税抜" : "税込";
    parts.push(`金額: ${input.amountJpy.toLocaleString()}円(${taxLabel})`);
    if (validation.taxExcludedAmountJpy !== undefined && input.taxIncluded !== false) {
      parts.push(`税抜: ${validation.taxExcludedAmountJpy.toLocaleString()}円`);
    }
  }

  if (input.category) {
    parts.push(`分類: ${input.category}`);
  }

  parts.push(`目的: ${input.purpose}`);
  parts.push(`概要: ${input.description}`);

  if (validation.fiscalYear) {
    parts.push(`会計年度: ${validation.fiscalYear}`);
  }

  return parts.join("\n");
}
