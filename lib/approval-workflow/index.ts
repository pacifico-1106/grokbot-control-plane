/**
 * F8 Approval Workflow — Main integration module
 *
 * Provides workflow-aware approval creation and resolution.
 * When workflow policy is absent, falls back to current OR/single-approver (AC W1).
 */

export {
  evaluateQuorum,
  evaluateStageAdvance,
  evaluateFinalGo,
  buildWorkflowProgress,
  shouldCreateWorkflowInstance,
  isVoterInCurrentStage,
  canVoterResolve,
  formatQuorumDisplay,
} from "./engine";

export {
  getOrgApprovalWorkflowPolicy,
  getEmployeeApprovalWorkflowPolicy,
  getEffectiveApprovalWorkflowPolicy,
  setOrgApprovalWorkflowPolicy,
  setEmployeeApprovalWorkflowPolicy,
  createWorkflowInstance,
  getWorkflowInstanceByApprovalId,
  getWorkflowInstanceById,
  updateWorkflowInstance,
  createBallotsForStage,
  createFinalGoBallot,
  getBallotsByInstanceId,
  getBallotForVoter,
  castBallot,
  getPendingBallotsByVoter,
  listActiveWorkflowInstances,
  resetDemoWorkflowData,
  getMemberIdFromVoterBinding,
  type EffectiveApprovalWorkflowPolicy,
  type ApprovalWorkflowPolicySource,
} from "./data";

export {
  initializeWorkflowForApproval,
  handleWorkflowVote,
  getApprovalWorkflowProgress,
  getCurrentStageVoterUserIds,
  isWorkflowApprovalComplete,
  type WorkflowVoteResult,
  type WorkflowInitResult,
} from "./resolve";

export {
  validateApprovalWorkflowPolicy,
  normalizeApprovalWorkflowPolicy,
  summarizeApprovalWorkflowPolicyJa,
  nextStepApprovalWorkflowJa,
} from "./validate";

export {
  createPendingVoterBinding,
  verifyVoterBinding,
  revokeVoterBinding,
  listVoterBindings,
  getVoterBinding,
  getVoterBindingByNonce,
  regenerateVerificationForBinding,
  checkSetupApproverBindingStatus,
  resetDemoVoterBindings,
  generateVerificationNonce,
  isTelegramGlobalChannelKey,
  TELEGRAM_GLOBAL_CHANNEL_KEY,
  type VoterBinding,
  type VoterBindingProvider,
  type VoterBindingStatus,
  type PendingBindingInfo,
  type RegenerateVerificationResult,
} from "./voter-binding";

export {
  sendVerificationDmToSlackUser,
  handleVerificationButtonClick,
  handleVerificationRejection,
  parseVerificationCallbackValue,
} from "./voter-binding-verification";

export {
  sendVerificationToTelegramUser,
  sendVerificationToTelegramUserViaChannel,
  sendVerificationToTelegramGroup,
  buildTelegramVerificationCallbackValue,
  handleTelegramVerificationConfirm,
  handleTelegramVerificationReject,
  parseTelegramVerificationCallbackValue,
  getTelegramCallbackDataByteLength,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
} from "./telegram-binding-verification";

export {
  resendVoterVerification,
  type ResendVoterVerificationInput,
  type ResendVoterVerificationResult,
} from "./admin";
