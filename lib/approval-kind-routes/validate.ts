/**
 * P1 Approval Kind Routes — Validation
 *
 * SECURITY: This module is the SINGLE shared validation enforced in 3 places:
 * 1. Web save API
 * 2. MCP patch filing
 * 3. Just before persisting after approval
 *
 * Invariants enforced:
 * - No AI approvers (ai_approver_forbidden)
 * - No self-approval (self_approval_forbidden)
 * - account kind requires owner/admin human approvers only
 * - Zero approvers forbidden
 * - Quorum cannot exceed valid approvers
 * - T2 cannot have finalGo or veto
 * - amountThreshold must be non-negative
 * - remindEveryDays must be positive
 */

import type {
  ApprovalKind,
  ApprovalKindQuorum,
  ApprovalKindRoute,
  DecisionWorkflowConfig,
  TopicGateConfig,
} from "./types";
import { APPROVAL_KINDS } from "./types";
import {
  MIN_DEADLINE_HOURS,
  MAX_DEADLINE_HOURS,
  MIN_TAX_RATE,
  MAX_TAX_RATE,
  MAX_SENSITIVE_TOPICS,
  DEFAULT_SENSITIVE_TOPICS as PRESET_DEFAULT_SENSITIVE_TOPICS,
  createDefaultApprovalKindRoute,
  createDefaultDecisionWorkflowConfig as createPresetDefaultDecisionWorkflowConfig,
  createDefaultTopicGateConfig as createPresetDefaultTopicGateConfig,
} from "./presets";

export interface ValidationError {
  code: string;
  path?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export interface ValidatorContext {
  orgOwnerUserIds: string[];
  orgAdminUserIds: string[];
  orgHumanMemberUserIds: string[];
  aiEmployeeUserIds: string[];
  requesterId?: string | null;
}

/**
 * Validate quorum rule.
 */
function isValidQuorum(quorum: unknown): quorum is ApprovalKindQuorum {
  if (!quorum || typeof quorum !== "object") return false;
  const q = quorum as Record<string, unknown>;

  if (q.type === "any") return true;
  if (q.type === "all") return true;
  if (
    q.type === "count" &&
    typeof q.n === "number" &&
    Number.isSafeInteger(q.n) &&
    q.n >= 1
  ) {
    return true;
  }
  return false;
}

/**
 * Validate a single approval kind route.
 */
function validateRoute(
  route: unknown,
  path: string,
  ctx: ValidatorContext
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!route || typeof route !== "object") {
    errors.push({ code: "invalid_route", path, message: "route must be an object" });
    return errors;
  }

  const r = route as Record<string, unknown>;
  const kind = r.kind as ApprovalKind | undefined;

  // Validate kind
  if (!kind || !APPROVAL_KINDS.includes(kind)) {
    errors.push({
      code: "invalid_kind",
      path: `${path}.kind`,
      message: `kind must be one of: ${APPROVAL_KINDS.join(", ")}`,
    });
  }

  // Validate approverUserIds
  const approverUserIds = r.approverUserIds;
  if (!Array.isArray(approverUserIds)) {
    errors.push({
      code: "invalid_approvers",
      path: `${path}.approverUserIds`,
      message: "approverUserIds must be an array",
    });
  } else if (approverUserIds.length === 0) {
    errors.push({
      code: "zero_approvers_forbidden",
      path: `${path}.approverUserIds`,
      message: "at least one approver is required",
    });
  } else {
    // Check for AI approvers (forbidden)
    for (const userId of approverUserIds) {
      if (typeof userId !== "string" || !userId.trim()) {
        errors.push({
          code: "invalid_approver_id",
          path: `${path}.approverUserIds`,
          message: "approver ids must be non-empty strings",
        });
        break;
      }
      if (ctx.aiEmployeeUserIds.includes(userId)) {
        errors.push({
          code: "ai_approver_forbidden",
          path: `${path}.approverUserIds`,
          message: "AI employees cannot be approvers",
        });
        break;
      }
    }

    // Check for duplicate approvers
    if (new Set(approverUserIds).size !== approverUserIds.length) {
      errors.push({
        code: "duplicate_approver",
        path: `${path}.approverUserIds`,
        message: "approvers must be unique",
      });
    }

    // account kind: only owner/admin allowed
    if (kind === "account") {
      const allowedApprovers = [
        ...ctx.orgOwnerUserIds,
        ...ctx.orgAdminUserIds,
      ];
      for (const userId of approverUserIds) {
        if (!allowedApprovers.includes(userId)) {
          errors.push({
            code: "account_kind_requires_owner_admin",
            path: `${path}.approverUserIds`,
            message: "account kind approvers must be owner or admin role",
          });
          break;
        }
      }
    }

    // Self-approval check: requester cannot be in approvers
    if (ctx.requesterId && approverUserIds.includes(ctx.requesterId)) {
      errors.push({
        code: "self_approval_forbidden",
        path: `${path}.approverUserIds`,
        message: "requester cannot approve their own request",
      });
    }
  }

  // Validate quorum
  const quorum = r.quorum;
  if (!isValidQuorum(quorum)) {
    errors.push({
      code: "invalid_quorum",
      path: `${path}.quorum`,
      message: "quorum must be { type: 'any' } | { type: 'count', n: number } | { type: 'all' }",
    });
  } else if (
    quorum.type === "count" &&
    Array.isArray(approverUserIds) &&
    quorum.n > approverUserIds.length
  ) {
    errors.push({
      code: "unreachable_quorum",
      path: `${path}.quorum`,
      message: "quorum count exceeds number of approvers",
    });
  }

  // Validate onExpire
  const onExpire = r.onExpire;
  if (onExpire !== "fail_closed" && onExpire !== "keep_open") {
    errors.push({
      code: "invalid_on_expire",
      path: `${path}.onExpire`,
      message: "onExpire must be 'fail_closed' or 'keep_open'",
    });
  }

  // Validate remindEveryDays
  const remindEveryDays = r.remindEveryDays;
  if (typeof remindEveryDays !== "number" || remindEveryDays <= 0) {
    errors.push({
      code: "invalid_remind_every_days",
      path: `${path}.remindEveryDays`,
      message: "remindEveryDays must be a positive number",
    });
  }

  // Validate deadlineHours (optional)
  if (r.deadlineHours !== undefined && r.deadlineHours !== null) {
    if (typeof r.deadlineHours !== "number" || r.deadlineHours <= 0) {
      errors.push({
        code: "invalid_deadline_hours",
        path: `${path}.deadlineHours`,
        message: "deadlineHours must be a positive number when set",
      });
    }
  }

  // Validate finalGoUserId (optional)
  if (r.finalGoUserId !== undefined && r.finalGoUserId !== null) {
    if (typeof r.finalGoUserId !== "string" || !r.finalGoUserId.trim()) {
      errors.push({
        code: "invalid_final_go_user",
        path: `${path}.finalGoUserId`,
        message: "finalGoUserId must be a non-empty string when set",
      });
    } else if (ctx.aiEmployeeUserIds.includes(r.finalGoUserId)) {
      errors.push({
        code: "ai_approver_forbidden",
        path: `${path}.finalGoUserId`,
        message: "AI employees cannot be finalGo approvers",
      });
    }
  }

  return errors;
}

/**
 * Validate decision tier route (T1/T2/T3).
 */
function validateDecisionTierRoute(
  route: unknown,
  path: string,
  ctx: ValidatorContext
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!route || typeof route !== "object") {
    errors.push({ code: "invalid_tier_route", path, message: "tier route must be an object" });
    return errors;
  }

  const r = route as Record<string, unknown>;
  const tier = r.tier;

  // Validate tier
  if (tier !== "T1" && tier !== "T2" && tier !== "T3") {
    errors.push({
      code: "invalid_tier",
      path: `${path}.tier`,
      message: "tier must be 'T1', 'T2', or 'T3'",
    });
  }

  // T2 specific validations
  if (tier === "T2") {
    // T2 cannot have finalGo
    if (r.finalGoUserId !== undefined && r.finalGoUserId !== null) {
      errors.push({
        code: "t2_final_go_forbidden",
        path: `${path}.finalGoUserId`,
        message: "T2 (理事過半数) cannot have finalGo (八坂 has no veto)",
      });
    }
  }

  // Validate approverUserIds
  const approverUserIds = r.approverUserIds;
  if (!Array.isArray(approverUserIds) || approverUserIds.length === 0) {
    errors.push({
      code: "zero_approvers_forbidden",
      path: `${path}.approverUserIds`,
      message: "at least one approver is required for tier",
    });
  } else {
    for (const userId of approverUserIds) {
      if (ctx.aiEmployeeUserIds.includes(userId as string)) {
        errors.push({
          code: "ai_approver_forbidden",
          path: `${path}.approverUserIds`,
          message: "AI employees cannot be decision approvers",
        });
        break;
      }
    }
  }

  // Validate quorum
  const quorum = r.quorum;
  if (!isValidQuorum(quorum)) {
    errors.push({
      code: "invalid_quorum",
      path: `${path}.quorum`,
      message: "quorum must be { type: 'any' } | { type: 'count', n: number } | { type: 'all' }",
    });
  } else if (
    quorum.type === "count" &&
    Array.isArray(approverUserIds) &&
    quorum.n > approverUserIds.length
  ) {
    errors.push({
      code: "unreachable_quorum",
      path: `${path}.quorum`,
      message: "quorum count exceeds number of approvers",
    });
  }

  // Validate onExpire
  if (r.onExpire !== "fail_closed" && r.onExpire !== "keep_open") {
    errors.push({
      code: "invalid_on_expire",
      path: `${path}.onExpire`,
      message: "onExpire must be 'fail_closed' or 'keep_open'",
    });
  }

  // Validate remindEveryDays
  if (typeof r.remindEveryDays !== "number" || r.remindEveryDays <= 0) {
    errors.push({
      code: "invalid_remind_every_days",
      path: `${path}.remindEveryDays`,
      message: "remindEveryDays must be a positive number",
    });
  }

  // Validate deadlineHours (optional, but must be within bounds when set)
  if (r.deadlineHours !== undefined && r.deadlineHours !== null) {
    if (typeof r.deadlineHours !== "number") {
      errors.push({
        code: "invalid_deadline_hours",
        path: `${path}.deadlineHours`,
        message: "deadlineHours must be a number when set",
      });
    } else if (r.deadlineHours < MIN_DEADLINE_HOURS || r.deadlineHours > MAX_DEADLINE_HOURS) {
      errors.push({
        code: "deadline_hours_out_of_range",
        path: `${path}.deadlineHours`,
        message: `deadlineHours must be between ${MIN_DEADLINE_HOURS} and ${MAX_DEADLINE_HOURS}`,
      });
    }
  }

  return errors;
}

/**
 * Validate decision workflow config.
 */
function validateDecisionWorkflowConfig(
  config: unknown,
  path: string,
  ctx: ValidatorContext
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!config || typeof config !== "object") {
    return errors; // Optional config
  }

  const c = config as Record<string, unknown>;

  // Validate amountThresholdJpy
  if (typeof c.amountThresholdJpy !== "number" || c.amountThresholdJpy < 0) {
    errors.push({
      code: "invalid_amount_threshold",
      path: `${path}.amountThresholdJpy`,
      message: "amountThresholdJpy must be a non-negative number",
    });
  }

  // Validate fiscalYearStartMonth
  if (
    typeof c.fiscalYearStartMonth !== "number" ||
    c.fiscalYearStartMonth < 1 ||
    c.fiscalYearStartMonth > 12
  ) {
    errors.push({
      code: "invalid_fiscal_year_month",
      path: `${path}.fiscalYearStartMonth`,
      message: "fiscalYearStartMonth must be 1-12",
    });
  }

  // Validate fiscalYearStartDay
  if (
    typeof c.fiscalYearStartDay !== "number" ||
    c.fiscalYearStartDay < 1 ||
    c.fiscalYearStartDay > 31
  ) {
    errors.push({
      code: "invalid_fiscal_year_day",
      path: `${path}.fiscalYearStartDay`,
      message: "fiscalYearStartDay must be 1-31",
    });
  }

  // Validate consumptionTaxRate (optional, default 0.10)
  if (c.consumptionTaxRate !== undefined && c.consumptionTaxRate !== null) {
    if (typeof c.consumptionTaxRate !== "number") {
      errors.push({
        code: "invalid_consumption_tax_rate",
        path: `${path}.consumptionTaxRate`,
        message: "consumptionTaxRate must be a number",
      });
    } else if (c.consumptionTaxRate < MIN_TAX_RATE || c.consumptionTaxRate > MAX_TAX_RATE) {
      errors.push({
        code: "consumption_tax_rate_out_of_range",
        path: `${path}.consumptionTaxRate`,
        message: `consumptionTaxRate must be between ${MIN_TAX_RATE} and ${MAX_TAX_RATE}`,
      });
    }
  }

  // Validate deputyUserId (optional)
  if (c.deputyUserId !== undefined && c.deputyUserId !== null) {
    if (typeof c.deputyUserId !== "string" || !c.deputyUserId.trim()) {
      errors.push({
        code: "invalid_deputy_user",
        path: `${path}.deputyUserId`,
        message: "deputyUserId must be a non-empty string when set",
      });
    } else if (ctx.aiEmployeeUserIds.includes(c.deputyUserId)) {
      errors.push({
        code: "ai_deputy_forbidden",
        path: `${path}.deputyUserId`,
        message: "AI employees cannot be deputy",
      });
    }
  }

  // Validate tiers
  const tiers = c.tiers;
  if (!Array.isArray(tiers)) {
    errors.push({
      code: "invalid_tiers",
      path: `${path}.tiers`,
      message: "tiers must be an array",
    });
  } else {
    for (let i = 0; i < tiers.length; i++) {
      errors.push(...validateDecisionTierRoute(tiers[i], `${path}.tiers[${i}]`, ctx));
    }
  }

  return errors;
}

/**
 * Validate topic gate config.
 */
function validateTopicGateConfig(config: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!config || typeof config !== "object") {
    return errors; // Optional config
  }

  const c = config as Record<string, unknown>;

  // Validate sensitiveTopics
  if (c.sensitiveTopics !== undefined) {
    if (!Array.isArray(c.sensitiveTopics)) {
      errors.push({
        code: "invalid_sensitive_topics",
        path: `${path}.sensitiveTopics`,
        message: "sensitiveTopics must be an array",
      });
    } else {
      // Empty array is valid: it means "no sensitive topics"
      if (c.sensitiveTopics.length > MAX_SENSITIVE_TOPICS) {
        errors.push({
          code: "sensitive_topics_limit_exceeded",
          path: `${path}.sensitiveTopics`,
          message: `sensitiveTopics cannot exceed ${MAX_SENSITIVE_TOPICS} items`,
        });
      }
      for (const topic of c.sensitiveTopics) {
        if (typeof topic !== "string" || !topic.trim()) {
          errors.push({
            code: "invalid_sensitive_topic",
            path: `${path}.sensitiveTopics`,
            message: "sensitiveTopics must be non-empty strings",
          });
          break;
        }
      }
    }
  }

  // Validate mainBoardChannelIds
  if (c.mainBoardChannelIds !== undefined) {
    if (!Array.isArray(c.mainBoardChannelIds)) {
      errors.push({
        code: "invalid_main_board_channels",
        path: `${path}.mainBoardChannelIds`,
        message: "mainBoardChannelIds must be an array",
      });
    }
  }

  return errors;
}

/**
 * Validate a complete approval kind routes policy.
 *
 * This is the SINGLE shared validation function enforced in 3 places:
 * 1. Web save API
 * 2. MCP patch filing
 * 3. Just before persisting after approval
 */
export function validateApprovalRoutes(
  input: unknown,
  ctx: ValidatorContext
): ValidationResult {
  const errors: ValidationError[] = [];

  if (!input || typeof input !== "object") {
    return { ok: false, errors: [{ code: "invalid_input", message: "policy must be an object" }] };
  }

  const policy = input as Record<string, unknown>;

  // Validate policyName
  if (typeof policy.policyName !== "string" || !policy.policyName.trim()) {
    errors.push({ code: "missing_policy_name", path: "policyName", message: "policyName is required" });
  }

  // Validate routes
  const routes = policy.routes;
  if (!Array.isArray(routes)) {
    errors.push({ code: "missing_routes", path: "routes", message: "routes array is required" });
  } else if (routes.length === 0) {
    errors.push({ code: "empty_routes", path: "routes", message: "at least one route is required" });
  } else {
    const seenKinds = new Set<string>();
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i] as Record<string, unknown>;
      errors.push(...validateRoute(route, `routes[${i}]`, ctx));

      // Check for duplicate kinds
      if (route.kind && seenKinds.has(route.kind as string)) {
        errors.push({
          code: "duplicate_kind",
          path: `routes[${i}].kind`,
          message: `duplicate route kind: ${route.kind}`,
        });
      }
      if (route.kind) seenKinds.add(route.kind as string);
    }
  }

  // Validate topicGate (optional)
  if (policy.topicGate !== undefined) {
    errors.push(...validateTopicGateConfig(policy.topicGate, "topicGate"));
  }

  // Validate decisionWorkflow (optional)
  if (policy.decisionWorkflow !== undefined) {
    errors.push(...validateDecisionWorkflowConfig(policy.decisionWorkflow, "decisionWorkflow", ctx));
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Default approval kind route (owner 1名).
 * Re-exported from presets for backward compatibility.
 */
export const defaultApprovalKindRoute = createDefaultApprovalKindRoute;

/**
 * Default sensitive topics list.
 * Re-exported from presets for backward compatibility.
 * Note: These are generic defaults, not tenant-specific.
 */
export const DEFAULT_SENSITIVE_TOPICS = PRESET_DEFAULT_SENSITIVE_TOPICS;

/**
 * Default topic gate config.
 * Re-exported from presets for backward compatibility.
 */
export const defaultTopicGateConfig = createPresetDefaultTopicGateConfig;

/**
 * Default decision workflow config.
 * Re-exported from presets for backward compatibility.
 */
export const defaultDecisionWorkflowConfig = createPresetDefaultDecisionWorkflowConfig;
