/**
 * P1 Plan Rails — Plan upgrade handler with always_human approval.
 *
 * Upgrades require always_human approval before taking effect.
 * This ensures business owners explicitly confirm scope widening.
 *
 * Flow:
 * 1. User requests upgrade (via Stripe checkout or admin action)
 * 2. This handler creates an always_human approval ticket
 * 3. Business owner approves/rejects
 * 4. On approval, upgrade is applied immediately
 *
 * SECURITY INVARIANT: Upgrades never auto-apply. Always require human approval.
 */

import { isPlanRailsEnabled } from "@/lib/feature-flags";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { createApproval, getApprovalById } from "@/lib/data";
import { appendAuditEvent } from "@/lib/data";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import {
  isValidPlanKey,
  isPlanUpgrade,
  getAddedGatewayTools,
  PLAN_DISPLAY_INFO,
  type PlanKey,
} from "./plan-scopes";
import { getOrgPlanInfo, updateOrgPlanKey, clearScheduledPlanChange } from "./org-plan";

export interface UpgradeTicketInput {
  orgId: string;
  currentPlan: PlanKey | null;
  newPlan: PlanKey;
  stripeSubscriptionId?: string;
  source: "stripe_checkout" | "admin_action" | "web_api";
  actorEmail?: string;
  actorMemberId?: string;
}

export interface UpgradeTicketResult {
  ok: boolean;
  ticketId?: string;
  approvalId?: string;
  error?: string;
}

/**
 * Create an upgrade approval ticket.
 *
 * Business rule: Upgrades require always_human approval.
 * The ticket is created in plan_upgrade_tickets and an approval_request is filed.
 *
 * When P1_PLAN_RAILS_ENABLED is OFF, this is a no-op (returns success without ticket).
 */
export async function createUpgradeTicket(
  input: UpgradeTicketInput
): Promise<UpgradeTicketResult> {
  if (!isPlanRailsEnabled()) {
    return { ok: true };
  }

  if (!isValidPlanKey(input.newPlan)) {
    return { ok: false, error: "invalid_plan_key" };
  }

  if (!isPlanUpgrade(input.currentPlan, input.newPlan)) {
    return { ok: false, error: "not_an_upgrade" };
  }

  if (isDemoMode()) {
    return { ok: true, ticketId: `demo_upgrade_${Date.now()}` };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, error: "supabase_not_configured" };
  }

  try {
    const currentPlanDisplay = input.currentPlan
      ? PLAN_DISPLAY_INFO[input.currentPlan].nameJa
      : "Legacy";
    const newPlanDisplay = PLAN_DISPLAY_INFO[input.newPlan].nameJa;
    const addedTools = getAddedGatewayTools(input.currentPlan, input.newPlan);

    const ticketId = `upgrade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const { error: insertError } = await admin.from("plan_upgrade_tickets").insert({
      id: ticketId,
      org_id: input.orgId,
      current_plan_key: input.currentPlan,
      new_plan_key: input.newPlan,
      stripe_subscription_id: input.stripeSubscriptionId ?? null,
      source: input.source,
      status: "pending_approval",
      created_at: new Date().toISOString(),
    });

    if (insertError) {
      console.error("[plan-rails] Failed to create upgrade ticket:", insertError);
      return { ok: false, error: "ticket_creation_failed" };
    }

    const approval = await createApproval({
      orgId: input.orgId,
      employeeId: "",
      credentialId: "",
      tool: "plan.upgrade",
      title: `プランアップグレード: ${currentPlanDisplay} → ${newPlanDisplay}`,
      summary: `プランを ${currentPlanDisplay} から ${newPlanDisplay} にアップグレードします。承認後、新しい機能が利用可能になります。`,
      purpose: "plan_upgrade",
      risk: "high",
      metadata: {
        ticketId,
        currentPlan: input.currentPlan,
        newPlan: input.newPlan,
        addedTools,
        stripeSubscriptionId: input.stripeSubscriptionId,
        source: input.source,
        actorEmail: input.actorEmail,
        actorMemberId: input.actorMemberId,
      },
    });

    const { error: updateError } = await admin
      .from("plan_upgrade_tickets")
      .update({ approval_id: approval.approval.id })
      .eq("id", ticketId);

    if (updateError) {
      console.error("[plan-rails] Failed to link approval to ticket:", updateError);
    }

    await sendApprovalNotifications(approval.approval, null);

    await appendAuditEvent({
      orgId: input.orgId,
      employeeId: "",
      credentialId: "",
      actorEmail: input.actorEmail ?? "system",
      action: "plan.upgrade_requested",
      purpose: null,
      summary: `プランアップグレードを申請: ${currentPlanDisplay} → ${newPlanDisplay}`,
      metadata: {
        ticketId,
        approvalId: approval.approval.id,
        currentPlan: input.currentPlan,
        newPlan: input.newPlan,
        source: input.source,
      },
    });

    return {
      ok: true,
      ticketId,
      approvalId: approval.approval.id,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[plan-rails] Error creating upgrade ticket:", e);
    return { ok: false, error: msg };
  }
}

/**
 * Apply an approved upgrade.
 *
 * Called when the upgrade approval is approved.
 * Updates the org's plan_key and clears any scheduled downgrade.
 *
 * SECURITY: Only call this after verifying the approval is approved.
 */
export async function applyApprovedUpgrade(
  ticketId: string,
  orgId: string,
  approvalId: string,
  resolverEmail: string
): Promise<{ ok: boolean; error?: string }> {
  if (!isPlanRailsEnabled()) {
    return { ok: true };
  }

  if (isDemoMode()) {
    return { ok: true };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, error: "supabase_not_configured" };
  }

  try {
    const { data: ticket, error: fetchError } = await admin
      .from("plan_upgrade_tickets")
      .select("*")
      .eq("id", ticketId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (fetchError || !ticket) {
      return { ok: false, error: "ticket_not_found" };
    }

    if (ticket.status !== "pending_approval") {
      return { ok: false, error: "ticket_not_pending" };
    }

    const approval = await getApprovalById(approvalId, orgId);
    if (!approval || approval.status !== "approved") {
      return { ok: false, error: "approval_not_approved" };
    }

    const oldPlan = ticket.current_plan_key as PlanKey | null;
    const newPlan = ticket.new_plan_key as PlanKey;

    await updateOrgPlanKey(orgId, newPlan);

    await clearScheduledPlanChange(orgId);

    const { error: updateError } = await admin
      .from("plan_upgrade_tickets")
      .update({
        status: "applied",
        applied_at: new Date().toISOString(),
        applied_by: resolverEmail,
      })
      .eq("id", ticketId);

    if (updateError) {
      console.error("[plan-rails] Failed to update ticket status:", updateError);
    }

    const oldPlanDisplay = oldPlan ? PLAN_DISPLAY_INFO[oldPlan].nameJa : "Legacy";
    const newPlanDisplay = PLAN_DISPLAY_INFO[newPlan].nameJa;

    await appendAuditEvent({
      orgId,
      employeeId: "",
      credentialId: "",
      actorEmail: resolverEmail,
      action: "plan.upgrade_applied",
      purpose: null,
      summary: `プランアップグレードを適用: ${oldPlanDisplay} → ${newPlanDisplay}`,
      metadata: {
        ticketId,
        approvalId,
        oldPlan,
        newPlan,
        appliedBy: resolverEmail,
      },
    });

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[plan-rails] Error applying upgrade:", e);
    return { ok: false, error: msg };
  }
}

/**
 * Reject an upgrade request.
 *
 * Called when the upgrade approval is rejected.
 * Marks the ticket as rejected.
 */
export async function rejectUpgrade(
  ticketId: string,
  orgId: string,
  approvalId: string,
  resolverEmail: string,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  if (!isPlanRailsEnabled()) {
    return { ok: true };
  }

  if (isDemoMode()) {
    return { ok: true };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, error: "supabase_not_configured" };
  }

  try {
    const { error: updateError } = await admin
      .from("plan_upgrade_tickets")
      .update({
        status: "rejected",
        rejection_reason: reason ?? null,
      })
      .eq("id", ticketId)
      .eq("org_id", orgId);

    if (updateError) {
      console.error("[plan-rails] Failed to reject upgrade ticket:", updateError);
      return { ok: false, error: "update_failed" };
    }

    const { data: ticket } = await admin
      .from("plan_upgrade_tickets")
      .select("current_plan_key, new_plan_key")
      .eq("id", ticketId)
      .maybeSingle();

    const oldPlanDisplay = ticket?.current_plan_key
      ? PLAN_DISPLAY_INFO[ticket.current_plan_key as PlanKey]?.nameJa ?? "Legacy"
      : "Legacy";
    const newPlanDisplay = ticket?.new_plan_key
      ? PLAN_DISPLAY_INFO[ticket.new_plan_key as PlanKey]?.nameJa ?? "Unknown"
      : "Unknown";

    await appendAuditEvent({
      orgId,
      employeeId: "",
      credentialId: "",
      actorEmail: resolverEmail,
      action: "plan.upgrade_rejected",
      purpose: null,
      summary: `プランアップグレードを却下: ${oldPlanDisplay} → ${newPlanDisplay}`,
      metadata: {
        ticketId,
        approvalId,
        reason,
        rejectedBy: resolverEmail,
      },
    });

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[plan-rails] Error rejecting upgrade:", e);
    return { ok: false, error: msg };
  }
}

/**
 * Get pending upgrade ticket for an org.
 */
export async function getPendingUpgradeTicket(
  orgId: string
): Promise<{
  id: string;
  currentPlan: PlanKey | null;
  newPlan: PlanKey;
  approvalId: string | null;
  createdAt: string;
} | null> {
  if (isDemoMode()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { data, error } = await admin
    .from("plan_upgrade_tickets")
    .select("id, current_plan_key, new_plan_key, approval_id, created_at")
    .eq("org_id", orgId)
    .eq("status", "pending_approval")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    id: data.id,
    currentPlan: data.current_plan_key as PlanKey | null,
    newPlan: data.new_plan_key as PlanKey,
    approvalId: data.approval_id,
    createdAt: data.created_at,
  };
}
