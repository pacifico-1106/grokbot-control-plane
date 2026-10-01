/**
 * P1 Approval Kind Routes — Main module
 *
 * Per-kind approval routing with quorum, finalGo, deadline, reminders.
 * Feature flag: P1_APPROVAL_KIND_ROUTES_ENABLED (default OFF)
 */

export * from "./types";
export * from "./tool-kind-map";
export {
  validateApprovalRoutes,
  defaultApprovalKindRoute,
  defaultTopicGateConfig,
  defaultDecisionWorkflowConfig,
  DEFAULT_SENSITIVE_TOPICS,
  type ValidationError,
  type ValidationResult,
  type ValidatorContext,
} from "./validate";
export {
  DEFAULT_CONSUMPTION_TAX_RATE,
  DEFAULT_FISCAL_YEAR_START_MONTH,
  DEFAULT_FISCAL_YEAR_START_DAY,
  DEFAULT_REMIND_EVERY_DAYS,
  MIN_DEADLINE_HOURS,
  MAX_DEADLINE_HOURS,
  MIN_TAX_RATE,
  MAX_TAX_RATE,
  MAX_T3_KEYWORDS,
  MAX_SENSITIVE_TOPICS,
  createDefaultApprovalKindRoute,
  createDefaultApprovalKindRoutes,
  createDefaultDecisionTierRoute,
  createDefaultDecisionWorkflowConfig,
  createDefaultTopicGateConfig,
} from "./presets";
export {
  getOrgApprovalKindRoutesPolicy,
  setOrgApprovalKindRoutesPolicy,
  getEmployeeApprovalKindRoutesOverride,
  setEmployeeApprovalKindRoutesOverride,
  getEffectiveApprovalKindRoute,
  getAllEffectiveApprovalKindRoutes,
  migrateClassRoutesToKindRoutes,
  resetDemoApprovalKindRoutesData,
} from "./data";
export {
  evaluateKindQuorum,
  formatKindQuorumDisplay,
  calculateDeadlineStatus,
  calculateReminderStatus,
  resolveKindApproval,
  getApprovalKind,
  getRouteForApproval,
  canUserVoteOnKindApproval,
  determineDecisionTier,
  canDowngradeTier,
  getPendingApprovers,
  type KindQuorumEvaluation,
  type DeadlineStatus,
  type ReminderStatus,
  type KindApprovalResolution,
  type DecisionTierResolution,
} from "./engine";
export {
  getKindRouteApprovers,
  buildSyntheticWorkflowPolicy,
  shouldUseKindRouting,
  calculateKindRouteExpiry,
  isKindRouteExpired,
  isKindRouteExpiredByDeadline,
  shouldSendKindRouteReminder,
  buildKindRoutingMetadata,
  parseKindRoutingMetadata,
  getKindRouteOnExpire,
  isKindRoutedApproval,
  evaluateKindRouteExpiry,
  evaluateKindRouteReminder,
  type KindRoutingMetadata,
} from "./workflow-bridge";
export {
  handleApprovalRoutesGet,
  validateApprovalRoutesPatch,
  buildValidatorContext,
  generatePolicyDiff,
  checkBeforeStateMatch,
  type ApprovalRoutesGetResult,
  type ApprovalRoutesPatchInput,
  type ApprovalRoutesPatchResult,
} from "./mcp-handlers";
