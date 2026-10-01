/**
 * P1 Decision Workflow — Types
 *
 * Types for decision.request and decision tier workflow.
 * Security:
 * - AI cannot be a decision approver
 * - Self-approval forbidden
 * - T2 has 72h deadline with fail_closed
 * - T3 requires all approval (社員総会)
 */

import type { DecisionTier } from "@/lib/approval-kind-routes/types";

export type { DecisionTier };

/**
 * Decision request input from Employee MCP.
 */
export interface DecisionRequestInput {
  title: string;
  description: string;
  purpose: string;
  jobId: string;
  amountJpy?: number | null;
  taxIncluded?: boolean;
  category?: string | null;
  requestedTier?: DecisionTier | null;
  deputyUserId?: string | null;
  attachments?: DecisionAttachment[];
}

/**
 * Attachment for a decision request.
 */
export interface DecisionAttachment {
  type: "document" | "image" | "link";
  name: string;
  url?: string;
  fileRef?: string;
  mimeType?: string;
  bytes?: number;
}

/**
 * Validation result for decision request.
 */
export interface DecisionRequestValidation {
  ok: boolean;
  errors?: string[];
  resolvedTier?: DecisionTier;
  tierReason?: string;
  taxExcludedAmountJpy?: number;
  fiscalYear?: string;
}

/**
 * Result from decision request creation.
 */
export interface DecisionRequestResult {
  ok: boolean;
  code?: string;
  message?: string;
  approvalId?: string;
  statusToken?: string;
  pollUrl?: string;
  pollHint?: string;
  tier?: DecisionTier;
  tierReason?: string;
  title?: string;
  summary?: string;
  fiscalYear?: string;
  deputyUserId?: string | null;
}

/**
 * Fiscal year calculation result.
 */
export interface FiscalYearInfo {
  fiscalYear: string;
  startDate: Date;
  endDate: Date;
  isCurrentFiscalYear: boolean;
}

/**
 * NOTE: Tenant-specific constants have been removed.
 *
 * - T3_AUTO_ESCALATION_KEYWORDS: Moved to presets/mirai-shachu.ts
 *   Use DecisionWorkflowConfig.tierRouting for keyword-based escalation.
 *
 * - CONSUMPTION_TAX_RATE: Use DecisionWorkflowConfig.consumptionTaxRate
 *   or DEFAULT_CONSUMPTION_TAX_RATE from presets/defaults.ts (Japan standard 10%).
 *
 * Legacy behavior (no config): Request goes to lowest-rank configured tier.
 * みらい社中 behavior requires applying the mirai-shachu preset.
 */
