/**
 * Approval Kind Routes Presets
 *
 * This module exports preset configurations and default values.
 * The defaults are generic and tenant-neutral.
 * Tenant-specific presets (like mirai-shachu) are for reference only.
 */

// Default (neutral) values used for all organizations
export {
  DEFAULT_CONSUMPTION_TAX_RATE,
  DEFAULT_AMOUNT_THRESHOLD_JPY,
  DEFAULT_FISCAL_YEAR_START_MONTH,
  DEFAULT_FISCAL_YEAR_START_DAY,
  DEFAULT_REMIND_EVERY_DAYS,
  MIN_DEADLINE_HOURS,
  MAX_DEADLINE_HOURS,
  MIN_TAX_RATE,
  MAX_TAX_RATE,
  MAX_T3_KEYWORDS,
  MAX_SENSITIVE_TOPICS,
  EMPTY_SENSITIVE_TOPICS,
  DEFAULT_SENSITIVE_TOPICS,
  createDefaultApprovalKindRoute,
  createDefaultApprovalKindRoutes,
  createDefaultDecisionTierRoute,
  createDefaultDecisionWorkflowConfig,
  createDefaultTopicGateConfig,
} from "./defaults";

// みらい社中 preset (reference only, not used in logic)
export {
  MIRAI_SHACHU_T3_KEYWORDS,
  MIRAI_SHACHU_SENSITIVE_TOPICS,
  MIRAI_SHACHU_AMOUNT_THRESHOLD_JPY,
  MIRAI_SHACHU_FISCAL_YEAR_START_MONTH,
  MIRAI_SHACHU_FISCAL_YEAR_START_DAY,
  MIRAI_SHACHU_T2_DEADLINE_HOURS,
  MIRAI_SHACHU_REMIND_EVERY_DAYS,
  MIRAI_SHACHU_CONSUMPTION_TAX_RATE,
  createMiraiShachuTierRoutes,
  createMiraiShachuDecisionWorkflowConfig,
  createMiraiShachuTopicGateConfig,
} from "./mirai-shachu";
