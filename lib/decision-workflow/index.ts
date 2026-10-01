/**
 * P1 Decision Workflow — Public API
 *
 * Re-exports for decision workflow functionality.
 */

export * from "./types";
export {
  calculateFiscalYear,
  calculateTaxExcludedAmount,
  containsT3Keywords,
  determineDecisionTier,
  getTierRoute,
  handleDecisionRequest,
  validateDecisionRequest,
} from "./request";

export {
  buildDecisionVotingCard,
  formatDecisionCardForSlack,
  formatDecisionCardForTelegram,
  type DecisionVotingCard,
  type DecisionCardAction,
} from "./voting-card";

export {
  calculateDecisionProgress,
  checkDecisionStalled,
  handleT2Expiry,
  shouldAutoExpire,
  generateProgressSummary,
  type DecisionVote,
  type DecisionProgressState,
  type DecisionStuckItem,
  type T2ExpiryResult,
} from "./progress";

export {
  buildReturnNotification,
  formatMinutesAsJson,
  formatMinutesAsMarkdown,
  generateDecisionMinutes,
  isConnectSharedChannel,
  recordDecisionResult,
  validateReturnTarget,
  type DecisionMinutes,
  type DecisionResult,
  type DecisionResultStatus,
  type ReturnNotificationConfig,
} from "./result";

export {
  isDecisionRequest,
  sendDecisionVotingCard,
  type DecisionNotificationResult,
} from "./notify";

export {
  buildTopicGateApprovalMetadata,
  checkTopicGate,
  containsSensitiveTopic,
  createDefaultTopicGateConfig,
  DEFAULT_SENSITIVE_TOPICS,
  formatTopicGateCard,
  isMainBoardChannel,
  validateTopicGateConfig,
  type TopicGateCheckResult,
} from "./topic-gate";

export {
  buildDeputyActivationApprovalMetadata,
  isDeputyActivationRequest,
  recordDeputyActivation,
  validateDeputyActivation,
  type DeputyActivationInput,
  type DeputyActivationResult,
} from "./deputy";
