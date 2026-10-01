/**
 * P1 Plan Rails — Client-side UI helpers for plan gating.
 *
 * These utilities determine what to show/hide in the dashboard
 * based on the org's current plan. When planRailsEnabled is false,
 * all features appear available (byte-identical to pre-rails behavior).
 *
 * IMPORTANT: These are UI hints only. Actual enforcement happens server-side.
 */

import type { PlanKey } from "./plan-scopes";
import {
  PLAN_DISPLAY_INFO,
  PLAN_TIER_ORDER,
  isGatewayToolAvailableForPlan,
  isAdminToolAvailableForPlan,
} from "./plan-scopes";
import type { GatewayToolId } from "@/lib/gateway/tools";
import type { AdminMcpToolName } from "@/lib/mcp/admin-public";

/**
 * UI feature names for plan-gated dashboard sections.
 * Maps to specific dashboard features that may be plan-gated.
 */
export type UiFeature =
  | "advanced_settings"
  | "audit_export"
  | "team_roles"
  | "policy_editor"
  | "approval_routes"
  | "external_sharing"
  | "browser_automation"
  | "commerce"
  | "line_approval"
  | "identity_management";

/**
 * UI feature to minimum plan mapping.
 * Features not listed are available to all plans (including legacy null).
 */
const UI_FEATURE_MIN_PLAN: Partial<Record<UiFeature, PlanKey>> = {
  policy_editor: "proper",
  approval_routes: "proper",
  audit_export: "executive",
  external_sharing: "executive",
  browser_automation: "executive",
  commerce: "proper",
  identity_management: "executive",
};

/**
 * Check if a UI feature is available for a given plan.
 * When planRailsEnabled is false, always returns true.
 */
export function isUiFeatureAvailable(
  feature: UiFeature,
  planKey: PlanKey | null,
  planRailsEnabled: boolean
): boolean {
  if (!planRailsEnabled) {
    return true;
  }
  if (planKey === null) {
    return true;
  }

  const minPlan = UI_FEATURE_MIN_PLAN[feature];
  if (!minPlan) {
    return true;
  }

  const currentTier = PLAN_TIER_ORDER[planKey];
  const requiredTier = PLAN_TIER_ORDER[minPlan];
  return currentTier >= requiredTier;
}

/**
 * Get the minimum plan required for a UI feature.
 * Returns null if feature is available to all plans.
 */
export function getMinPlanForUiFeature(
  feature: UiFeature
): PlanKey | null {
  return UI_FEATURE_MIN_PLAN[feature] ?? null;
}

/**
 * Get plans that have a specific UI feature.
 * Returns all plans if feature has no minimum requirement.
 */
export function getPlansWithUiFeature(feature: UiFeature): PlanKey[] {
  const minPlan = UI_FEATURE_MIN_PLAN[feature];
  if (!minPlan) {
    return ["intern", "proper", "executive"];
  }

  const minTier = PLAN_TIER_ORDER[minPlan];
  return (["intern", "proper", "executive"] as PlanKey[]).filter(
    (p) => PLAN_TIER_ORDER[p] >= minTier
  );
}

/**
 * Get plan display info for UI badges and labels.
 */
export function getPlanDisplayName(planKey: PlanKey | null): string {
  if (!planKey) {
    return "Legacy";
  }
  return PLAN_DISPLAY_INFO[planKey]?.nameJa ?? planKey;
}

/**
 * Get plan description for tooltips.
 */
export function getPlanDescription(planKey: PlanKey): string {
  return PLAN_DISPLAY_INFO[planKey]?.descriptionJa ?? "";
}

/**
 * Check if gateway tool is available for plan (client-side version).
 * When planRailsEnabled is false, always returns true.
 */
export function isGatewayToolAvailableForPlanUi(
  toolId: GatewayToolId | string,
  planKey: PlanKey | null,
  planRailsEnabled: boolean
): boolean {
  if (!planRailsEnabled) {
    return true;
  }
  return isGatewayToolAvailableForPlan(toolId, planKey);
}

/**
 * Check if admin MCP tool is available for plan (client-side version).
 * When planRailsEnabled is false, always returns true.
 */
export function isAdminToolAvailableForPlanUi(
  toolName: AdminMcpToolName | string,
  planKey: PlanKey | null,
  planRailsEnabled: boolean
): boolean {
  if (!planRailsEnabled) {
    return true;
  }
  return isAdminToolAvailableForPlan(toolName, planKey);
}

/**
 * Get upgrade suggestion for a feature.
 * Returns the plan to upgrade to, or null if already at highest tier or feature available.
 */
export function getUpgradeSuggestion(
  feature: UiFeature,
  currentPlan: PlanKey | null,
  planRailsEnabled: boolean
): PlanKey | null {
  if (!planRailsEnabled) {
    return null;
  }
  if (currentPlan === null) {
    return null;
  }
  if (currentPlan === "executive") {
    return null;
  }

  const minPlan = UI_FEATURE_MIN_PLAN[feature];
  if (!minPlan) {
    return null;
  }

  const currentTier = PLAN_TIER_ORDER[currentPlan];
  const requiredTier = PLAN_TIER_ORDER[minPlan];

  if (currentTier >= requiredTier) {
    return null;
  }

  return minPlan;
}

/**
 * Format scheduled downgrade message for display.
 */
export function formatScheduledDowngradeMessage(
  scheduledPlanKey: PlanKey | null,
  scheduledEffectiveAt: string | null
): string | null {
  if (!scheduledPlanKey || !scheduledEffectiveAt) {
    return null;
  }

  const effectiveDate = new Date(scheduledEffectiveAt);
  const formatted = effectiveDate.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const planName = getPlanDisplayName(scheduledPlanKey);

  return `${formatted} に ${planName} プランへ変更予定`;
}
