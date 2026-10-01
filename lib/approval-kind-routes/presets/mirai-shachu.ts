/**
 * みらい社中 Preset Values
 *
 * This file contains all tenant-specific values for みらい社中 organization.
 * These values are used ONLY when generating default policy for this specific org,
 * or as a reference preset. They must NOT be hardcoded in logic modules.
 *
 * All other orgs use the neutral defaults from ./defaults.ts
 */

import type {
  DecisionWorkflowConfig,
  TopicGateConfig,
  DecisionTierRoute,
} from "../types";

/**
 * みらい社中 T3 auto-escalation keywords.
 * Decision requests containing these keywords auto-escalate to T3 (社員総会).
 */
export const MIRAI_SHACHU_T3_KEYWORDS: readonly string[] = [
  "定款変更",
  "役員",
  "決算",
  "解散",
  "合併",
  "分割",
  "資本金",
  "重要財産",
] as const;

/**
 * みらい社中 sensitive topics for topic-gated posting.
 * Posts containing these topics require human approval.
 */
export const MIRAI_SHACHU_SENSITIVE_TOPICS: readonly string[] = [
  "決算",
  "役員",
  "定款",
  "人事",
  "給与",
  "個人情報",
  "法務",
  "訴訟",
  "契約",
  "NDA",
  "秘密保持",
] as const;

/**
 * みらい社中 amount threshold for T2 escalation (tax-excluded).
 */
export const MIRAI_SHACHU_AMOUNT_THRESHOLD_JPY = 500000;

/**
 * みらい社中 fiscal year start: April 1st
 */
export const MIRAI_SHACHU_FISCAL_YEAR_START_MONTH = 4;
export const MIRAI_SHACHU_FISCAL_YEAR_START_DAY = 1;

/**
 * みらい社中 T2 deadline: 72 hours
 */
export const MIRAI_SHACHU_T2_DEADLINE_HOURS = 72;

/**
 * みらい社中 reminder interval: every 3 days
 */
export const MIRAI_SHACHU_REMIND_EVERY_DAYS = 3;

/**
 * Japan consumption tax rate (10%)
 */
export const MIRAI_SHACHU_CONSUMPTION_TAX_RATE = 0.10;

/**
 * Create みらい社中 decision tier routes.
 * T1 = 専決 (owner decision)
 * T2 = 理事過半数 (72h deadline, fail_closed)
 * T3 = 社員総会 (all members must approve)
 */
export function createMiraiShachuTierRoutes(
  ownerUserId: string,
  boardMemberUserIds: string[] = [],
  allMemberUserIds: string[] = []
): DecisionTierRoute[] {
  return [
    {
      tier: "T1",
      nameJa: "代表理事の専決",
      approverUserIds: [ownerUserId],
      quorum: { type: "any" },
      finalGoUserId: null,
      deadlineHours: null,
      onExpire: "keep_open",
      remindEveryDays: MIRAI_SHACHU_REMIND_EVERY_DAYS,
    },
    {
      tier: "T2",
      nameJa: "理事過半数",
      approverUserIds: boardMemberUserIds.length > 0 ? boardMemberUserIds : [ownerUserId],
      quorum: { type: "count", n: Math.ceil((boardMemberUserIds.length || 1) / 2) },
      finalGoUserId: null,
      deadlineHours: MIRAI_SHACHU_T2_DEADLINE_HOURS,
      onExpire: "fail_closed",
      remindEveryDays: MIRAI_SHACHU_REMIND_EVERY_DAYS,
    },
    {
      tier: "T3",
      nameJa: "社員総会",
      approverUserIds: allMemberUserIds.length > 0 ? allMemberUserIds : [ownerUserId],
      quorum: { type: "all" },
      finalGoUserId: null,
      deadlineHours: null,
      onExpire: "keep_open",
      remindEveryDays: MIRAI_SHACHU_REMIND_EVERY_DAYS,
    },
  ];
}

/**
 * Create みらい社中 decision workflow config.
 */
export function createMiraiShachuDecisionWorkflowConfig(
  ownerUserId: string,
  boardMemberUserIds: string[] = [],
  allMemberUserIds: string[] = []
): DecisionWorkflowConfig {
  return {
    amountThresholdJpy: MIRAI_SHACHU_AMOUNT_THRESHOLD_JPY,
    fiscalYearStartMonth: MIRAI_SHACHU_FISCAL_YEAR_START_MONTH,
    fiscalYearStartDay: MIRAI_SHACHU_FISCAL_YEAR_START_DAY,
    consumptionTaxRate: MIRAI_SHACHU_CONSUMPTION_TAX_RATE,
    deputyUserId: null,
    tiers: createMiraiShachuTierRoutes(ownerUserId, boardMemberUserIds, allMemberUserIds),
  };
}

/**
 * Create みらい社中 topic gate config.
 */
export function createMiraiShachuTopicGateConfig(): TopicGateConfig {
  return {
    enabled: true,
    sensitiveTopics: [...MIRAI_SHACHU_SENSITIVE_TOPICS],
    mainBoardChannelIds: [],
  };
}
