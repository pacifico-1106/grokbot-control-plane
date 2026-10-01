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
