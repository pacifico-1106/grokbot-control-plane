/**
 * P1 Plan Rails — Plan change handlers.
 *
 * Handles plan upgrades, downgrades, and status changes:
 * - Scheduled downgrades take effect at billing period end
 * - Cancellation and suspension narrow scope immediately
 * - Upgrades require always_human approval (handled in PR-H)
 *
 * SECURITY INVARIANT: Fail closed on errors. Never widen scope.
 */

import { isPlanRailsEnabled } from "@/lib/feature-flags";
import {
  getOrgPlanInfo,
  updateOrgPlanKey,
  updateOrgBillingStatus,
  scheduleOrgPlanDowngrade,
  applyScheduledPlanChange,
  clearScheduledPlanChange,
} from "./org-plan";
import {
  isValidPlanKey,
  isPlanDowngrade,
  isPlanUpgrade,
  getRevokedGatewayTools,
  getRevokedAdminTools,
  type PlanKey,
} from "./plan-scopes";
import { appendAuditEvent } from "@/lib/data";
import { cancelPendingApprovalsForTools } from "./approval-cancellation";

export type PlanChangeResult =
  | { ok: true; action: "scheduled" | "applied" | "no_change" }
  | { ok: false; error: string; code: string };

/**
 * Handle a plan downgrade request.
 *
 * Business rule: Downgrades take effect at billing period end (scheduled),
 * NOT immediately. This gives the org time to adjust.
 *
 * Exception: Cancellation and suspension narrow scope immediately via
 * handleBillingStatusChange().
 *
 * When P1_PLAN_RAILS_ENABLED is OFF, this is a no-op.
 */
export async function handlePlanDowngrade(
  orgId: string,
  currentPlan: PlanKey | null,
  newPlan: PlanKey,
  effectiveAt: string,
  metadata?: { source?: string; actorEmail?: string }
): Promise<PlanChangeResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true, action: "no_change" };
  }

  if (!isValidPlanKey(newPlan)) {
    return { ok: false, error: "invalid_plan_key", code: "invalid_plan" };
  }

  if (!isPlanDowngrade(currentPlan, newPlan)) {
    return { ok: false, error: "not_a_downgrade", code: "not_downgrade" };
  }

  try {
    await scheduleOrgPlanDowngrade(orgId, newPlan, effectiveAt);

    await appendAuditEvent({
      orgId,
      employeeId: "",
      credentialId: "",
      actorEmail: metadata?.actorEmail ?? "system",
      action: "plan.downgrade_scheduled",
      purpose: null,
      summary: `プランダウングレードを予約: ${currentPlan ?? "legacy"} → ${newPlan} (${effectiveAt})`,
      metadata: {
        currentPlan,
        newPlan,
        effectiveAt,
        source: metadata?.source ?? "unknown",
      },
    });

    return { ok: true, action: "scheduled" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "schedule_failed";
    return { ok: false, error: msg, code: "schedule_failed" };
  }
}

/**
 * Apply a scheduled plan change.
 *
 * Called when the billing period ends or by a cron job.
 * Cancels pending approvals for revoked tools.
 *
 * When P1_PLAN_RAILS_ENABLED is OFF, this is a no-op.
 */
export async function applyScheduledDowngrade(
  orgId: string,
  metadata?: { source?: string }
): Promise<PlanChangeResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true, action: "no_change" };
  }

  try {
    const result = await applyScheduledPlanChange(orgId);

    if (!result.applied) {
      return { ok: true, action: "no_change" };
    }

    const revokedGateway = getRevokedGatewayTools(result.oldPlanKey, result.newPlanKey);
    const revokedAdmin = getRevokedAdminTools(result.oldPlanKey, result.newPlanKey);

    if (revokedGateway.length > 0 || revokedAdmin.length > 0) {
      await cancelPendingApprovalsForTools(orgId, revokedGateway, revokedAdmin, {
        reason: "plan_downgrade",
        summary: `プランダウングレードにより権限が縮小されたためキャンセル`,
      });
    }

    await appendAuditEvent({
      orgId,
      employeeId: "",
      credentialId: "",
      actorEmail: "system",
      action: "plan.downgrade_applied",
      purpose: null,
      summary: `プランダウングレードを適用: ${result.oldPlanKey ?? "legacy"} → ${result.newPlanKey ?? "legacy"}`,
      metadata: {
        oldPlan: result.oldPlanKey,
        newPlan: result.newPlanKey,
        revokedGatewayTools: revokedGateway,
        revokedAdminTools: revokedAdmin,
        source: metadata?.source ?? "scheduled",
      },
    });

    return { ok: true, action: "applied" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "apply_failed";
    return { ok: false, error: msg, code: "apply_failed" };
  }
}

/**
 * Cancel a scheduled downgrade.
 *
 * Called when user cancels their downgrade or upgrades again.
 *
 * When P1_PLAN_RAILS_ENABLED is OFF, this is a no-op.
 */
export async function cancelScheduledDowngrade(
  orgId: string,
  metadata?: { source?: string; actorEmail?: string }
): Promise<PlanChangeResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true, action: "no_change" };
  }

  try {
    const planInfo = await getOrgPlanInfo(orgId);
    if (!planInfo?.scheduledPlanKey) {
      return { ok: true, action: "no_change" };
    }

    await clearScheduledPlanChange(orgId);

    await appendAuditEvent({
      orgId,
      employeeId: "",
      credentialId: "",
      actorEmail: metadata?.actorEmail ?? "system",
      action: "plan.downgrade_cancelled",
      purpose: null,
      summary: `プランダウングレードをキャンセル`,
      metadata: {
        cancelledPlan: planInfo.scheduledPlanKey,
        currentPlan: planInfo.planKey,
        source: metadata?.source ?? "unknown",
      },
    });

    return { ok: true, action: "applied" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "cancel_failed";
    return { ok: false, error: msg, code: "cancel_failed" };
  }
}

/**
 * Handle billing status change (immediate scope narrowing).
 *
 * Business rule: Cancellation and suspension narrow scope IMMEDIATELY,
 * unlike downgrades which are scheduled.
 *
 * When billing status becomes 'canceled' or 'suspended':
 * - Cancel pending approvals for non-read tools
 * - Org can still read, but cannot execute actions
 *
 * When P1_PLAN_RAILS_ENABLED is OFF, nothing is written (billing_status is a
 * plan_rails column and may not exist before the migration is applied).
 */
export async function handleBillingStatusChange(
  orgId: string,
  newStatus: string,
  metadata?: { source?: string }
): Promise<PlanChangeResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true, action: "no_change" };
  }

  try {
    await updateOrgBillingStatus(orgId, newStatus);

    const isNarrowing = newStatus === "canceled" || newStatus === "suspended";

    if (isNarrowing) {
      const planInfo = await getOrgPlanInfo(orgId);
      const allGatewayTools = getRevokedGatewayTools(planInfo?.planKey, null);
      const allAdminTools = getRevokedAdminTools(planInfo?.planKey, null);

      if (allGatewayTools.length > 0 || allAdminTools.length > 0) {
        await cancelPendingApprovalsForTools(orgId, allGatewayTools, allAdminTools, {
          reason: "billing_status_change",
          summary: `契約ステータス変更 (${newStatus}) により保留中の承認をキャンセル`,
        });
      }

      await appendAuditEvent({
        orgId,
        employeeId: "",
        credentialId: "",
        actorEmail: "system",
        action: "plan.billing_status_narrowed",
        purpose: null,
        summary: `契約ステータス変更によりスコープを縮小: ${newStatus}`,
        metadata: {
          newStatus,
          revokedGatewayTools: allGatewayTools,
          revokedAdminTools: allAdminTools,
          source: metadata?.source ?? "stripe_webhook",
        },
      });
    }

    return { ok: true, action: "applied" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "status_update_failed";
    return { ok: false, error: msg, code: "status_update_failed" };
  }
}

/**
 * Handle immediate plan change (for special cases).
 *
 * Used for:
 * - Setting initial plan on org creation
 * - Immediate upgrade application (after always_human approval)
 *
 * When P1_PLAN_RAILS_ENABLED is OFF, this is a no-op.
 */
export async function applyImmediatePlanChange(
  orgId: string,
  newPlan: PlanKey | null,
  metadata?: { source?: string; actorEmail?: string }
): Promise<PlanChangeResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true, action: "no_change" };
  }

  try {
    const current = await getOrgPlanInfo(orgId);
    const oldPlan = current?.planKey ?? null;

    await updateOrgPlanKey(orgId, newPlan);

    if (isPlanDowngrade(oldPlan, newPlan)) {
      const revokedGateway = getRevokedGatewayTools(oldPlan, newPlan);
      const revokedAdmin = getRevokedAdminTools(oldPlan, newPlan);

      if (revokedGateway.length > 0 || revokedAdmin.length > 0) {
        await cancelPendingApprovalsForTools(orgId, revokedGateway, revokedAdmin, {
          reason: "immediate_plan_change",
          summary: `プラン変更により権限が縮小されたためキャンセル`,
        });
      }
    }

    await appendAuditEvent({
      orgId,
      employeeId: "",
      credentialId: "",
      actorEmail: metadata?.actorEmail ?? "system",
      action: "plan.changed",
      purpose: null,
      summary: `プランを変更: ${oldPlan ?? "legacy"} → ${newPlan ?? "legacy"}`,
      metadata: {
        oldPlan,
        newPlan,
        source: metadata?.source ?? "unknown",
      },
    });

    return { ok: true, action: "applied" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "apply_failed";
    return { ok: false, error: msg, code: "apply_failed" };
  }
}
