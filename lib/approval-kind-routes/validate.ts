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
 * - amountThreshold must be non-negative
 * - remindEveryDays must be positive
 * - Tier IDs must be unique
 * - Tier routing rules reference valid tiers
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
  MAX_T3_KEYWORDS,
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
 * Validate decision tier route (supports arbitrary tier IDs).
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

  // Validate tier ID (any non-empty string allowed)
  if (typeof tier !== "string" || !tier.trim()) {
    errors.push({
      code: "invalid_tier",
      path: `${path}.tier`,
      message: "tier must be a non-empty string",
    });
  } else if (tier.length > 50) {
    errors.push({
      code: "tier_id_too_long",
      path: `${path}.tier`,
      message: "tier id cannot exceed 50 characters",
    });
  }

  // Validate nameJa
  if (typeof r.nameJa !== "string" || !r.nameJa.trim()) {
    errors.push({
      code: "invalid_tier_name",
      path: `${path}.nameJa`,
      message: "nameJa must be a non-empty string",
    });
  }

  // Validate rank (optional, but must be valid number when set)
  if (r.rank !== undefined && r.rank !== null) {
    if (typeof r.rank !== "number" || !Number.isInteger(r.rank)) {
      errors.push({
        code: "invalid_tier_rank",
        path: `${path}.rank`,
        message: "rank must be an integer when set",
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
  } else if (tiers.length === 0) {
    errors.push({
      code: "at_least_one_tier_required",
      path: `${path}.tiers`,
      message: "at least one tier is required",
    });
  } else {
    const tierIds = new Set<string>();
    const ranks = new Set<number>();

    for (let i = 0; i < tiers.length; i++) {
      errors.push(...validateDecisionTierRoute(tiers[i], `${path}.tiers[${i}]`, ctx));

      const tier = tiers[i] as Record<string, unknown>;

      // Check for duplicate tier IDs
      const tierId = tier.tier as string;
      if (tierId && tierIds.has(tierId)) {
        errors.push({
          code: "duplicate_tier_id",
          path: `${path}.tiers[${i}].tier`,
          message: `duplicate tier id: ${tierId}`,
        });
      }
      if (tierId) tierIds.add(tierId);

      // Check for duplicate ranks
      const rank = tier.rank as number | undefined;
      if (typeof rank === "number") {
        if (ranks.has(rank)) {
          errors.push({
            code: "duplicate_tier_rank",
            path: `${path}.tiers[${i}].rank`,
            message: `duplicate tier rank: ${rank}`,
          });
        }
        ranks.add(rank);
      }
    }

    // Validate tierRouting rules
    if (c.tierRouting !== undefined) {
      errors.push(...validateTierRoutingRules(c.tierRouting, `${path}.tierRouting`, tierIds));
    }

    // Validate defaultTierId references an existing tier
    if (c.defaultTierId !== undefined && c.defaultTierId !== null) {
      if (typeof c.defaultTierId !== "string" || !c.defaultTierId.trim()) {
        errors.push({
          code: "invalid_default_tier_id",
          path: `${path}.defaultTierId`,
          message: "defaultTierId must be a non-empty string when set",
        });
      } else if (!tierIds.has(c.defaultTierId)) {
        errors.push({
          code: "default_tier_id_not_found",
          path: `${path}.defaultTierId`,
          message: `defaultTierId references unknown tier: ${c.defaultTierId}`,
        });
      }
    }
  }

  return errors;
}

/**
 * Validate tier routing rules.
 */
function validateTierRoutingRules(
  rules: unknown,
  path: string,
  validTierIds: Set<string>
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Array.isArray(rules)) {
    errors.push({
      code: "invalid_tier_routing",
      path,
      message: "tierRouting must be an array",
    });
    return errors;
  }

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule || typeof rule !== "object") {
      errors.push({
        code: "invalid_tier_routing_rule",
        path: `${path}[${i}]`,
        message: "tier routing rule must be an object",
      });
      continue;
    }

    const r = rule as Record<string, unknown>;

    // Validate tierId
    if (typeof r.tierId !== "string" || !r.tierId.trim()) {
      errors.push({
        code: "invalid_routing_rule_tier_id",
        path: `${path}[${i}].tierId`,
        message: "tierId must be a non-empty string",
      });
    } else if (!validTierIds.has(r.tierId)) {
      errors.push({
        code: "routing_rule_tier_not_found",
        path: `${path}[${i}].tierId`,
        message: `tierId references unknown tier: ${r.tierId}`,
      });
    }

    // Validate match conditions
    if (!r.match || typeof r.match !== "object") {
      errors.push({
        code: "invalid_routing_rule_match",
        path: `${path}[${i}].match`,
        message: "match conditions object is required",
      });
    } else {
      errors.push(...validateTierMatchCondition(r.match, `${path}[${i}].match`));
    }
  }

  return errors;
}

/**
 * Validate tier match conditions.
 */
function validateTierMatchCondition(
  match: unknown,
  path: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!match || typeof match !== "object") {
    return errors;
  }

  const m = match as Record<string, unknown>;

  // Validate keywords (plain substring match, no regex)
  if (m.keywords !== undefined) {
    if (!Array.isArray(m.keywords)) {
      errors.push({
        code: "invalid_keywords",
        path: `${path}.keywords`,
        message: "keywords must be an array",
      });
    } else if (m.keywords.length > MAX_T3_KEYWORDS) {
      errors.push({
        code: "keywords_limit_exceeded",
        path: `${path}.keywords`,
        message: `keywords cannot exceed ${MAX_T3_KEYWORDS} items`,
      });
    } else {
      for (let i = 0; i < m.keywords.length; i++) {
        if (typeof m.keywords[i] !== "string" || !m.keywords[i].trim()) {
          errors.push({
            code: "invalid_keyword",
            path: `${path}.keywords[${i}]`,
            message: "keywords must be non-empty strings",
          });
          break;
        }
      }
    }
  }

  // Validate minAmountJpy
  if (m.minAmountJpy !== undefined && m.minAmountJpy !== null) {
    if (typeof m.minAmountJpy !== "number" || m.minAmountJpy < 0) {
      errors.push({
        code: "invalid_min_amount",
        path: `${path}.minAmountJpy`,
        message: "minAmountJpy must be a non-negative number",
      });
    }
  }

  // Validate categories
  if (m.categories !== undefined) {
    if (!Array.isArray(m.categories)) {
      errors.push({
        code: "invalid_categories",
        path: `${path}.categories`,
        message: "categories must be an array",
      });
    } else {
      for (let i = 0; i < m.categories.length; i++) {
        if (typeof m.categories[i] !== "string" || !m.categories[i].trim()) {
          errors.push({
            code: "invalid_category",
            path: `${path}.categories[${i}]`,
            message: "categories must be non-empty strings",
          });
          break;
        }
      }
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
