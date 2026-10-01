/**
 * P1 Plan Rails — Fulfill-time plan re-check.
 *
 * Re-validates plan scope at fulfillment time to ensure the tool is still
 * available after approval but before execution. This handles the case where
 * the org's plan changes between approval creation and fulfillment.
 *
 * SECURITY INVARIANT: Fail closed. If plan check fails, do not fulfill.
 */

import { isPlanRailsEnabled } from "@/lib/feature-flags";
import { getOrgPlanInfo } from "./org-plan";
import {
  isGatewayToolAvailableForPlan,
  isAdminToolAvailableForPlan,
  PLAN_DISPLAY_INFO,
  type PlanKey,
} from "./plan-scopes";
import { appendAuditEvent } from "@/lib/data";
import type { ApprovalRequest } from "@/lib/types";

export type FulfillRecheckResult =
  | { ok: true; planKey: PlanKey | null }
  | {
      ok: false;
      code: "plan_scope_revoked" | "plan_suspended" | "plan_check_failed";
      planKey: PlanKey | null;
      messageJa: string;
    };

/**
 * Re-check plan scope at fulfillment time for gateway tools.
 *
 * Called just before executing an approved gateway tool invocation.
 * Returns ok=true if tool is still available, ok=false if plan has changed.
 *
 * When P1_PLAN_RAILS_ENABLED is OFF, always returns ok=true.
 */
export async function recheckGatewayToolAtFulfill(
  orgId: string,
  tool: string,
  approval: ApprovalRequest
): Promise<FulfillRecheckResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true, planKey: null };
  }

  try {
    const planInfo = await getOrgPlanInfo(orgId);
    if (!planInfo) {
      return { ok: true, planKey: null };
    }

    const { planKey, billingStatus } = planInfo;

    if (planKey === null) {
      return { ok: true, planKey: null };
    }

    if (billingStatus === "suspended" || billingStatus === "canceled") {
      await appendAuditEvent({
        orgId,
        employeeId: approval.employeeId,
        credentialId: approval.credentialId,
        actorEmail: "system",
        action: "plan.fulfill_blocked",
        purpose: approval.purpose,
        summary: `実行時に契約ステータス確認でブロック: ${billingStatus}`,
        metadata: {
          approvalId: approval.id,
          tool,
          planKey,
          billingStatus,
          reason: "billing_status_narrowed",
        },
      });

      return {
        ok: false,
        code: "plan_suspended",
        planKey,
        messageJa: `契約が${billingStatus === "suspended" ? "停止" : "解約"}されているため、実行できません。`,
      };
    }

    if (!isGatewayToolAvailableForPlan(tool, planKey)) {
      const planDisplay = PLAN_DISPLAY_INFO[planKey];

      await appendAuditEvent({
        orgId,
        employeeId: approval.employeeId,
        credentialId: approval.credentialId,
        actorEmail: "system",
        action: "plan.fulfill_blocked",
        purpose: approval.purpose,
        summary: `実行時にプランスコープ確認でブロック: ${tool}`,
        metadata: {
          approvalId: approval.id,
          tool,
          planKey,
          reason: "plan_scope_revoked",
        },
      });

      return {
        ok: false,
        code: "plan_scope_revoked",
        planKey,
        messageJa: `${tool} は ${planDisplay.nameJa} プランでは利用できなくなりました（承認後にプランが変更されました）`,
      };
    }

    return { ok: true, planKey };
  } catch (e) {
    console.error("[plan-rails] Error in recheckGatewayToolAtFulfill:", e);
    return {
      ok: false,
      code: "plan_check_failed",
      planKey: null,
      messageJa: "プラン確認に失敗しました（fail-closed）",
    };
  }
}

/**
 * Re-check plan scope at fulfillment time for admin MCP tools.
 *
 * Called just before executing an approved admin MCP tool.
 * Returns ok=true if tool is still available, ok=false if plan has changed.
 *
 * When P1_PLAN_RAILS_ENABLED is OFF, always returns ok=true.
 */
export async function recheckAdminToolAtFulfill(
  orgId: string,
  tool: string,
  approval: ApprovalRequest
): Promise<FulfillRecheckResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true, planKey: null };
  }

  try {
    const planInfo = await getOrgPlanInfo(orgId);
    if (!planInfo) {
      return { ok: true, planKey: null };
    }

    const { planKey, billingStatus } = planInfo;

    if (planKey === null) {
      return { ok: true, planKey: null };
    }

    if (billingStatus === "suspended" || billingStatus === "canceled") {
      await appendAuditEvent({
        orgId,
        employeeId: approval.employeeId,
        credentialId: approval.credentialId,
        actorEmail: "system",
        action: "plan.fulfill_blocked",
        purpose: approval.purpose,
        summary: `Admin MCP実行時に契約ステータス確認でブロック: ${billingStatus}`,
        metadata: {
          approvalId: approval.id,
          tool,
          planKey,
          billingStatus,
          reason: "billing_status_narrowed",
        },
      });

      return {
        ok: false,
        code: "plan_suspended",
        planKey,
        messageJa: `契約が${billingStatus === "suspended" ? "停止" : "解約"}されているため、実行できません。`,
      };
    }

    if (!isAdminToolAvailableForPlan(tool, planKey)) {
      const planDisplay = PLAN_DISPLAY_INFO[planKey];

      await appendAuditEvent({
        orgId,
        employeeId: approval.employeeId,
        credentialId: approval.credentialId,
        actorEmail: "system",
        action: "plan.fulfill_blocked",
        purpose: approval.purpose,
        summary: `Admin MCP実行時にプランスコープ確認でブロック: ${tool}`,
        metadata: {
          approvalId: approval.id,
          tool,
          planKey,
          reason: "plan_scope_revoked",
        },
      });

      return {
        ok: false,
        code: "plan_scope_revoked",
        planKey,
        messageJa: `${tool} は ${planDisplay.nameJa} プランでは利用できなくなりました（承認後にプランが変更されました）`,
      };
    }

    return { ok: true, planKey };
  } catch (e) {
    console.error("[plan-rails] Error in recheckAdminToolAtFulfill:", e);
    return {
      ok: false,
      code: "plan_check_failed",
      planKey: null,
      messageJa: "プラン確認に失敗しました（fail-closed）",
    };
  }
}
