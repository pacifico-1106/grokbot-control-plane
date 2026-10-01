/**
 * P1 Plan Rails — Gateway and Admin MCP plan gating.
 *
 * Enforces per-plan tool availability. When P1_PLAN_RAILS_ENABLED is OFF,
 * all tools remain available (byte-identical to pre-rails behavior).
 *
 * Security invariants:
 * - Plans control availability, not approval requirements
 * - always_human tools remain always_human regardless of plan
 * - NULL plan = legacy (no filtering)
 * - Invalid/unknown plan = fail closed (no tools)
 * - Suspended orgs have narrowed scope (read-only allowed)
 */

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

export type PlanGateResult =
  | {
      ok: true;
      planKey: PlanKey | null;
      billingStatus: string | null;
    }
  | {
      ok: false;
      code: "plan_scope_denied" | "plan_suspended" | "plan_unknown";
      planKey: PlanKey | null;
      billingStatus: string | null;
      tool: string;
      messageJa: string;
      availableInPlans?: PlanKey[];
    };

/**
 * Check if a gateway tool is allowed for an org's current plan.
 *
 * When P1_PLAN_RAILS_ENABLED is OFF, always returns ok=true.
 * When plan_key is NULL (legacy), always returns ok=true.
 * When plan is invalid or unknown, fails closed (no tools).
 * When billing_status is 'suspended', only read tools are allowed.
 */
export async function assertGatewayToolAllowedForPlan(
  orgId: string,
  toolId: GatewayToolId | string
): Promise<PlanGateResult> {
  if (!isPlanRailsEnabled()) {
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

  if (billingStatus === "suspended" || billingStatus === "canceled") {
    const toolDef = await import("@/lib/gateway/tools").then(m => m.resolveGatewayTool(toolId));
    if (toolDef.ok && toolDef.def.kind !== "read" && toolDef.def.kind !== "ping") {
      return {
        ok: false,
        code: "plan_suspended",
        planKey,
        billingStatus,
        tool: toolId,
        messageJa: "ご契約が停止中のため、このツールはご利用いただけません。お支払い状況をご確認ください。",
      };
    }
  }

  if (!isGatewayToolAvailableForPlan(toolId, planKey)) {
    const availableInPlans = (["intern", "proper", "executive"] as PlanKey[]).filter(
      p => isGatewayToolAvailableForPlan(toolId, p)
    );
    const planDisplay = PLAN_DISPLAY_INFO[planKey];
    const upgradeHint = availableInPlans.length > 0
      ? `（${availableInPlans.map(p => PLAN_DISPLAY_INFO[p].nameJa).join(" / ")} プランでご利用いただけます）`
      : "";

    return {
      ok: false,
      code: "plan_scope_denied",
      planKey,
      billingStatus,
      tool: toolId,
      messageJa: `${toolId} は ${planDisplay.nameJa} プランではご利用いただけません${upgradeHint}`,
      availableInPlans,
    };
  }

  return { ok: true, planKey, billingStatus };
}

/**
 * Check if an admin MCP tool is allowed for an org's current plan.
 *
 * Same semantics as gateway tool check, but uses admin tool scopes.
 * Read-only admin tools are never gated (always allowed).
 */
export async function assertAdminToolAllowedForPlan(
  orgId: string,
  toolName: AdminMcpToolName | string
): Promise<PlanGateResult> {
  if (!isPlanRailsEnabled()) {
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

  if (!isAdminToolAvailableForPlan(toolName, planKey)) {
    const availableInPlans = (["intern", "proper", "executive"] as PlanKey[]).filter(
      p => isAdminToolAvailableForPlan(toolName, p)
    );
    const planDisplay = PLAN_DISPLAY_INFO[planKey];
    const upgradeHint = availableInPlans.length > 0
      ? `（${availableInPlans.map(p => PLAN_DISPLAY_INFO[p].nameJa).join(" / ")} プランでご利用いただけます）`
      : "";

    return {
      ok: false,
      code: "plan_scope_denied",
      planKey,
      billingStatus,
      tool: toolName,
      messageJa: `${toolName} は ${planDisplay.nameJa} プランではご利用いただけません${upgradeHint}`,
      availableInPlans,
    };
  }

  return { ok: true, planKey, billingStatus };
}
