"use client";

import { useAppSession } from "@/components/AppSessionProvider";
import type { PlanKey } from "@/lib/billing/plan-scopes";
import {
  isUiFeatureAvailable,
  getUpgradeSuggestion,
  formatScheduledDowngradeMessage,
  isGatewayToolAvailableForPlanUi,
  isAdminToolAvailableForPlanUi,
  type UiFeature,
} from "@/lib/billing/plan-ui";
import type { GatewayToolId } from "@/lib/gateway/tools";
import type { AdminMcpToolName } from "@/lib/mcp/admin-public";

export type PlanGateInfo = {
  /** Current plan key (null = legacy) */
  planKey: PlanKey | null;
  /** Whether plan rails feature is enabled */
  planRailsEnabled: boolean;
  /** Scheduled downgrade plan if any */
  scheduledPlanKey: PlanKey | null;
  /** ISO timestamp when scheduled change takes effect */
  scheduledPlanEffectiveAt: string | null;
  /** Formatted scheduled downgrade message for display */
  scheduledDowngradeMessage: string | null;
  /** Check if a UI feature is available for the current plan */
  isFeatureAvailable: (feature: UiFeature) => boolean;
  /** Get upgrade suggestion for a feature */
  getUpgradePlan: (feature: UiFeature) => PlanKey | null;
  /** Check if a gateway tool is available for the current plan */
  isGatewayToolAvailable: (toolId: GatewayToolId | string) => boolean;
  /** Check if an admin MCP tool is available for the current plan */
  isAdminToolAvailable: (toolName: AdminMcpToolName | string) => boolean;
};

export function usePlanGate(): PlanGateInfo {
  const session = useAppSession();
  const {
    planKey,
    planRailsEnabled,
    scheduledPlanKey,
    scheduledPlanEffectiveAt,
  } = session;

  const scheduledDowngradeMessage = formatScheduledDowngradeMessage(
    scheduledPlanKey,
    scheduledPlanEffectiveAt
  );

  const isFeatureAvailable = (feature: UiFeature): boolean => {
    return isUiFeatureAvailable(feature, planKey, planRailsEnabled);
  };

  const getUpgradePlan = (feature: UiFeature): PlanKey | null => {
    return getUpgradeSuggestion(feature, planKey, planRailsEnabled);
  };

  const isGatewayToolAvailable = (toolId: GatewayToolId | string): boolean => {
    return isGatewayToolAvailableForPlanUi(toolId, planKey, planRailsEnabled);
  };

  const isAdminToolAvailable = (toolName: AdminMcpToolName | string): boolean => {
    return isAdminToolAvailableForPlanUi(toolName, planKey, planRailsEnabled);
  };

  return {
    planKey,
    planRailsEnabled,
    scheduledPlanKey,
    scheduledPlanEffectiveAt,
    scheduledDowngradeMessage,
    isFeatureAvailable,
    getUpgradePlan,
    isGatewayToolAvailable,
    isAdminToolAvailable,
  };
}
