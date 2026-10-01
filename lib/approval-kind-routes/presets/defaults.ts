/**
 * Neutral Default Values for Approval Kind Routes
 *
 * These are generic defaults that apply to all organizations.
 * They contain NO tenant-specific values.
 *
 * When a field is absent from org config, these defaults apply.
 * When an org explicitly sets a field (including empty arrays), that value is used.
 */

import type {
  ApprovalKind,
  ApprovalKindRoute,
  DecisionWorkflowConfig,
  TopicGateConfig,
  DecisionTierRoute,
  DecisionTier,
} from "../types";
import { APPROVAL_KINDS } from "../types";

/**
 * Default consumption tax rate for Japan (10%).
 * This is the Japan standard rate, not a tenant-specific value.
 * Used when org config doesn't specify a rate.
 */
export const DEFAULT_CONSUMPTION_TAX_RATE = 0.10;

/**
 * NOTE: DEFAULT_AMOUNT_THRESHOLD_JPY was removed.
 * Amount thresholds for tier escalation are tenant-specific policy.
 * The ¥500,000 threshold was みらい社中's policy, not a generic default.
 * Use tierRouting in DecisionWorkflowConfig for amount-based tier routing.
 */

/**
 * Default fiscal year start: April 1st (Japan standard).
 * This is the Japan standard, not a tenant-specific value.
 * Used when org config doesn't specify fiscal year settings.
 */
export const DEFAULT_FISCAL_YEAR_START_MONTH = 4;
export const DEFAULT_FISCAL_YEAR_START_DAY = 1;

/**
 * Default reminder interval in days.
 */
export const DEFAULT_REMIND_EVERY_DAYS = 3;

/**
 * Deadline hour bounds for validation.
 */
export const MIN_DEADLINE_HOURS = 1;
export const MAX_DEADLINE_HOURS = 8760; // 1 year

/**
 * Tax rate bounds for validation.
 */
export const MIN_TAX_RATE = 0;
export const MAX_TAX_RATE = 1;

/**
 * Keyword list size limits for validation.
 */
export const MAX_T3_KEYWORDS = 50;
export const MAX_SENSITIVE_TOPICS = 100;

/**
 * Empty sensitive topics - used when org explicitly sets an empty list.
 * This is distinct from a missing/undefined field.
 */
export const EMPTY_SENSITIVE_TOPICS: readonly string[] = [] as const;

/**
 * Default sensitive topics (generic list, not tenant-specific).
 * Applied only when generating a new default policy or when field is undefined.
 * An explicit empty list in config means "no topics".
 */
export const DEFAULT_SENSITIVE_TOPICS: readonly string[] = [
  "金額",
  "支払",
  "請求",
  "口座",
  "予算",
  "決算",
  "税務",
  "報酬",
  "契約条件",
  "個人情報",
  "役員人事",
  "定款",
] as const;

/**
 * Default approval kind route (owner 1名).
 */
export function createDefaultApprovalKindRoute(
  kind: ApprovalKind,
  ownerUserId: string
): ApprovalKindRoute {
  return {
    kind,
    approverUserIds: [ownerUserId],
    quorum: { type: "any" },
    finalGoUserId: null,
    deadlineHours: null,
    onExpire: "fail_closed",
    remindEveryDays: DEFAULT_REMIND_EVERY_DAYS,
    notifyChannelIds: [],
  };
}

/**
 * Create default routes for all approval kinds.
 */
export function createDefaultApprovalKindRoutes(ownerUserId: string): ApprovalKindRoute[] {
  return APPROVAL_KINDS.map((kind) => createDefaultApprovalKindRoute(kind, ownerUserId));
}

/**
 * Create default decision tier route.
 */
export function createDefaultDecisionTierRoute(
  tier: DecisionTier,
  nameJa: string,
  ownerUserId: string
): DecisionTierRoute {
  return {
    tier,
    nameJa,
    approverUserIds: [ownerUserId],
    quorum: { type: "any" },
    finalGoUserId: null,
    deadlineHours: null,
    onExpire: "keep_open",
    remindEveryDays: DEFAULT_REMIND_EVERY_DAYS,
  };
}

/**
 * Create default decision workflow config (minimal, single tier).
 *
 * NOTE: No amount threshold or keyword escalation is configured by default.
 * For tenant-specific escalation rules, use tierRouting in the config.
 * For みらい社中 behavior, apply the mirai-shachu preset.
 */
export function createDefaultDecisionWorkflowConfig(
  ownerUserId: string
): DecisionWorkflowConfig {
  return {
    fiscalYearStartMonth: DEFAULT_FISCAL_YEAR_START_MONTH,
    fiscalYearStartDay: DEFAULT_FISCAL_YEAR_START_DAY,
    consumptionTaxRate: DEFAULT_CONSUMPTION_TAX_RATE,
    deputyUserId: null,
    tiers: [
      createDefaultDecisionTierRoute("T1", "専決", ownerUserId),
    ],
  };
}

/**
 * Create default topic gate config (disabled).
 * When topicGate is undefined, topic gate is disabled.
 * When topicGate.sensitiveTopics is undefined, defaults apply.
 * When topicGate.sensitiveTopics is [], no topics are checked.
 */
export function createDefaultTopicGateConfig(): TopicGateConfig {
  return {
    enabled: false,
    sensitiveTopics: [...DEFAULT_SENSITIVE_TOPICS],
    mainBoardChannelIds: [],
  };
}
