/**
 * P1 Plan Rails — API-level plan gating helpers.
 *
 * Provides HTTP response builders for plan-gated API endpoints.
 * When P1_PLAN_RAILS_ENABLED is OFF, all checks pass (byte-identical to pre-rails).
 *
 * IMPORTANT: This is for REST API endpoints. Gateway and Admin MCP use separate gating.
 */

import { NextResponse } from "next/server";
import { isPlanRailsEnabled } from "@/lib/feature-flags";
import { getOrgPlanInfo } from "./org-plan";
import {
  isGatewayToolAvailableForPlan,
  isAdminToolAvailableForPlan,
  PLAN_DISPLAY_INFO,
  type PlanKey,
} from "./plan-scopes";
import type { GatewayToolId } from "@/lib/gateway/tools";
import type { AdminMcpToolName } from "@/lib/mcp/admin-public";
import type { UiFeature } from "./plan-ui";
import { isUiFeatureAvailable, getMinPlanForUiFeature } from "./plan-ui";

export type ApiPlanGateResult =
  | { ok: true; planKey: PlanKey | null; billingStatus: string | null }
  | { ok: false; response: NextResponse };

/**
 * Check if an API action is allowed for an org's current plan.
 * Returns ok=true or an HTTP 403 response with plan info.
 *
 * When P1_PLAN_RAILS_ENABLED is OFF, always returns ok=true.
 */
export async function assertApiPlanAllows(
  orgId: string | null | undefined,
  feature: UiFeature,
  actionJa: string
): Promise<ApiPlanGateResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true, planKey: null, billingStatus: null };
  }

  if (!orgId) {
    return { ok: true, planKey: null, billingStatus: null };
  }

  const planInfo = await getOrgPlanInfo(orgId);
  if (!planInfo) {
    return { ok: true, planKey: null, billingStatus: null };
  }

  const { planKey, billingStatus } = planInfo;

  if (planKey === null) {
    return { ok: true, planKey: null, billingStatus };
  }

  if (isUiFeatureAvailable(feature, planKey, true)) {
    return { ok: true, planKey, billingStatus };
  }

  const minPlan = getMinPlanForUiFeature(feature);
  const planDisplay = PLAN_DISPLAY_INFO[planKey];
  const upgradeHint = minPlan
    ? `（${PLAN_DISPLAY_INFO[minPlan].nameJa} プラン以上でご利用いただけます）`
    : "";

  return {
    ok: false,
    response: NextResponse.json(
      {
        ok: false,
        error: "plan_scope_denied",
        code: "plan_scope_denied",
        planKey,
        billingStatus,
        feature,
        message: `${actionJa}は ${planDisplay.nameJa} プランではご利用いただけません${upgradeHint}`,
        billingPath: "/app/billing",
        requiredPlan: minPlan,
      },
      { status: 403 }
    ),
  };
}

/**
 * Check if a gateway tool is allowed for an org's current plan (API-level).
 * Returns ok=true or an HTTP 403 response.
 *
 * Use this when exposing gateway functionality via REST API.
 */
export async function assertApiGatewayToolAllowed(
  orgId: string | null | undefined,
  toolId: GatewayToolId | string
): Promise<ApiPlanGateResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true, planKey: null, billingStatus: null };
  }

  if (!orgId) {
    return { ok: true, planKey: null, billingStatus: null };
  }

  const planInfo = await getOrgPlanInfo(orgId);
  if (!planInfo) {
    return { ok: true, planKey: null, billingStatus: null };
  }

  const { planKey, billingStatus } = planInfo;

  if (planKey === null) {
    return { ok: true, planKey: null, billingStatus };
  }

  if (isGatewayToolAvailableForPlan(toolId, planKey)) {
    return { ok: true, planKey, billingStatus };
  }

  const planDisplay = PLAN_DISPLAY_INFO[planKey];
  const availableInPlans = (["intern", "proper", "executive"] as PlanKey[]).filter(
    (p) => isGatewayToolAvailableForPlan(toolId, p)
  );
  const upgradeHint =
    availableInPlans.length > 0
      ? `（${availableInPlans.map((p) => PLAN_DISPLAY_INFO[p].nameJa).join(" / ")} プランでご利用いただけます）`
      : "";

  return {
    ok: false,
    response: NextResponse.json(
      {
        ok: false,
        error: "plan_scope_denied",
        code: "plan_scope_denied",
        planKey,
        billingStatus,
        tool: toolId,
        message: `${toolId} は ${planDisplay.nameJa} プランではご利用いただけません${upgradeHint}`,
        billingPath: "/app/billing",
        availableInPlans,
      },
      { status: 403 }
    ),
  };
}

/**
 * Check if an admin MCP tool is allowed for an org's current plan (API-level).
 * Returns ok=true or an HTTP 403 response.
 *
 * Use this when exposing admin MCP functionality via REST API.
 */
export async function assertApiAdminToolAllowed(
  orgId: string | null | undefined,
  toolName: AdminMcpToolName | string
): Promise<ApiPlanGateResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true, planKey: null, billingStatus: null };
  }

  if (!orgId) {
    return { ok: true, planKey: null, billingStatus: null };
  }

  const planInfo = await getOrgPlanInfo(orgId);
  if (!planInfo) {
    return { ok: true, planKey: null, billingStatus: null };
  }

  const { planKey, billingStatus } = planInfo;

  if (planKey === null) {
    return { ok: true, planKey: null, billingStatus };
  }

  if (isAdminToolAvailableForPlan(toolName, planKey)) {
    return { ok: true, planKey, billingStatus };
  }

  const planDisplay = PLAN_DISPLAY_INFO[planKey];
  const availableInPlans = (["intern", "proper", "executive"] as PlanKey[]).filter(
    (p) => isAdminToolAvailableForPlan(toolName, p)
  );
  const upgradeHint =
    availableInPlans.length > 0
      ? `（${availableInPlans.map((p) => PLAN_DISPLAY_INFO[p].nameJa).join(" / ")} プランでご利用いただけます）`
      : "";

  return {
    ok: false,
    response: NextResponse.json(
      {
        ok: false,
        error: "plan_scope_denied",
        code: "plan_scope_denied",
        planKey,
        billingStatus,
        tool: toolName,
        message: `${toolName} は ${planDisplay.nameJa} プランではご利用いただけません${upgradeHint}`,
        billingPath: "/app/billing",
        availableInPlans,
      },
      { status: 403 }
    ),
  };
}
