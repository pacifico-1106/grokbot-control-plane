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
 * Default consumption tax rate.
 * @deprecated Use DecisionWorkflowConfig.consumptionTaxRate from org policy.
 * This value is only used as fallback when config doesn't specify a rate.
 */
export const CONSUMPTION_TAX_RATE = 0.1;

/**
 * Auto-escalation keywords for T3.
 * @deprecated Will be moved to org config in a future PR.
 * These are みらい社中 specific values kept for backward compatibility.
 */
export const T3_AUTO_ESCALATION_KEYWORDS = [
  "定款変更",
  "役員",
  "決算",
  "解散",
  "合併",
  "分割",
  "資本金",
  "重要財産",
] as const;
