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
 * Check if text contains any of the given keywords (plain substring match).
 * Used for configurable tier routing rules.
 */
export function containsKeywords(text: string, keywords: readonly string[]): boolean {
  if (!keywords || keywords.length === 0) return false;
  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

/**
 * Get the lowest-rank tier from config.
 * Returns null if no tiers are configured.
 */
function getLowestRankTier(config: DecisionWorkflowConfig | null): DecisionTierRoute | null {
  if (!config?.tiers || config.tiers.length === 0) return null;

  // Sort by rank (ascending), tiers without rank come first (rank 0)
  const sorted = [...config.tiers].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return sorted[0];
}

/**
 * Get tier rank from config. Returns 0 for unknown tiers.
 */
function getTierRank(tier: DecisionTier, config: DecisionWorkflowConfig | null): number {
  if (!config?.tiers) return 0;
  const found = config.tiers.find((t) => t.tier === tier);
  return found?.rank ?? 0;
}

/**
 * Determine decision tier based on config.
 *
 * Behavior when no tierRouting is configured:
 * - NO keyword-based or amount-based auto-escalation
 * - Request goes to lowest-rank configured tier (or defaultTierId if set)
 * - Explicitly requested higher tier is honored (upgrade-only semantics)
 * - Owner can downgrade
 *
 * To get みらい社中 behavior (keyword/amount escalation), apply mirai-shachu preset.
 */
export function determineDecisionTier(
  input: DecisionRequestInput,
  config: DecisionWorkflowConfig | null,
  isOwner = false
): { tier: DecisionTier; reason: string } {
  // No tiers configured = fail closed
  if (!config?.tiers || config.tiers.length === 0) {
    return {
      tier: "T1", // fallback, but handleDecisionRequest will reject
      reason: "DECISION_TIERS_NOT_CONFIGURED",
    };
  }

  // Determine base tier (lowest rank or defaultTierId)
  let baseTier: DecisionTier;
  let baseReason: string;

  if (config.defaultTierId) {
    const defaultRoute = config.tiers.find((t) => t.tier === config.defaultTierId);
    if (defaultRoute) {
      baseTier = defaultRoute.tier;
      baseReason = "DEFAULT_TIER";
    } else {
      const lowest = getLowestRankTier(config)!;
      baseTier = lowest.tier;
      baseReason = "LOWEST_RANK_TIER";
    }
  } else {
    const lowest = getLowestRankTier(config)!;
    baseTier = lowest.tier;
    baseReason = "LOWEST_RANK_TIER";
  }

  // Apply tier routing rules if configured
  if (config.tierRouting && config.tierRouting.length > 0) {
    const amountJpy = input.amountJpy ?? 0;
    const taxRate = config.consumptionTaxRate ?? DEFAULT_CONSUMPTION_TAX_RATE;
    const taxExcluded = calculateTaxExcludedAmount(amountJpy, input.taxIncluded ?? true, taxRate);
    const textToCheck = `${input.title} ${input.description} ${input.category ?? ""}`;

    for (const rule of config.tierRouting) {
      const targetRoute = config.tiers.find((t) => t.tier === rule.tierId);
      if (!targetRoute) continue;

      const match = rule.match;
      let matched = false;
      let matchReason = "";

      // Check keywords
      if (match.keywords && match.keywords.length > 0) {
        if (containsKeywords(textToCheck, match.keywords)) {
          matched = true;
          matchReason = `KEYWORD_MATCH: ${rule.tierId}`;
        }
      }

      // Check minAmountJpy
      if (!matched && match.minAmountJpy !== undefined && match.minAmountJpy !== null) {
        if (taxExcluded >= match.minAmountJpy) {
          matched = true;
          matchReason = `AMOUNT_THRESHOLD: ${taxExcluded.toLocaleString()}円(税抜) >= ${match.minAmountJpy.toLocaleString()}円 → ${rule.tierId}`;
        }
      }

      // Check categories
      if (!matched && match.categories && match.categories.length > 0) {
        if (input.category && match.categories.includes(input.category)) {
          matched = true;
          matchReason = `CATEGORY_MATCH: ${input.category} → ${rule.tierId}`;
        }
      }

      if (matched) {
        baseTier = rule.tierId;
        baseReason = matchReason;
        break; // First matching rule wins
      }
    }
  }

  // Handle requested tier (upgrade-only unless owner)
  const requestedTier = input.requestedTier;
  if (requestedTier) {
    const requestedRank = getTierRank(requestedTier, config);
    const baseRank = getTierRank(baseTier, config);

    if (requestedRank > baseRank) {
      return {
        tier: requestedTier,
        reason: `REQUESTED_UPGRADE: ${baseTier} → ${requestedTier}`,
      };
    }

    if (requestedRank < baseRank && isOwner) {
      return {
        tier: requestedTier,
        reason: `OWNER_DOWNGRADE: ${baseTier} → ${requestedTier}`,
      };
    }
  }

  return {
    tier: baseTier,
    reason: baseReason,
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

  // Fail closed when no decision tiers are configured
  if (reason === "DECISION_TIERS_NOT_CONFIGURED") {
    return {
      ok: false,
      errors: ["decision_tiers_not_configured"],
    };
  }

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
