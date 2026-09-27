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
  checkSetupApproverBindingStatus,
  resetDemoVoterBindings,
  isTelegramGlobalChannelKey,
  TELEGRAM_GLOBAL_CHANNEL_KEY,
  type VoterBinding,
  type VoterBindingProvider,
  type VoterBindingStatus,
} from "./voter-binding";

export {
  sendVerificationDmToSlackUser,
  handleVerificationButtonClick,
  handleVerificationRejection,
  parseVerificationCallbackValue,
} from "./voter-binding-verification";

export {
  sendVerificationToTelegramUser,
  handleTelegramVerificationConfirm,
  handleTelegramVerificationReject,
  parseTelegramVerificationCallbackValue,
} from "./telegram-binding-verification";
