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
