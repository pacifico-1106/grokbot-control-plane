/**
 * P1 Plan Rails — Approval cancellation for plan changes.
 *
 * When plans change and tools are revoked, pending approvals for those
 * tools must be cancelled to prevent execution after the plan change.
 */

import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { appendAuditEvent } from "@/lib/data";
import type { GatewayToolId } from "@/lib/gateway/tools";
import type { AdminMcpToolName } from "@/lib/mcp/admin-public";

export interface CancellationContext {
  reason: string;
  summary: string;
}

/**
 * Cancel pending approvals for revoked tools.
 *
 * Called when:
 * - Plan downgrade is applied
 * - Billing status changes to canceled/suspended
 *
 * DEMO mode: no-op.
 */
export async function cancelPendingApprovalsForTools(
  orgId: string,
  revokedGatewayTools: GatewayToolId[],
  revokedAdminTools: AdminMcpToolName[],
  context: CancellationContext
): Promise<{ cancelled: number }> {
  if (isDemoMode()) {
    return { cancelled: 0 };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("[plan-rails] No admin client for approval cancellation");
    return { cancelled: 0 };
  }

  const allRevokedTools = [
    ...revokedGatewayTools,
    ...revokedAdminTools,
  ];

  if (allRevokedTools.length === 0) {
    return { cancelled: 0 };
  }

  try {
    const { data: pending, error: fetchError } = await admin
      .from("approval_requests")
      .select("id, tool, title")
      .eq("org_id", orgId)
      .eq("status", "pending")
      .in("tool", allRevokedTools);

    if (fetchError) {
      console.error("[plan-rails] Failed to fetch pending approvals:", fetchError);
      return { cancelled: 0 };
    }

    if (!pending || pending.length === 0) {
      return { cancelled: 0 };
    }

    const ids = pending.map((a) => a.id);

    const { error: updateError } = await admin
      .from("approval_requests")
      .update({
        status: "rejected",
        resolved_by: "system:plan_change",
        resolved_at: new Date().toISOString(),
        resolution_note: context.summary,
      })
      .eq("org_id", orgId)
      .eq("status", "pending")
      .in("id", ids);

    if (updateError) {
      console.error("[plan-rails] Failed to cancel approvals:", updateError);
      return { cancelled: 0 };
    }

    for (const approval of pending) {
      await appendAuditEvent({
        orgId,
        employeeId: "",
        credentialId: "",
        actorEmail: "system",
        action: "approval.cancelled_by_plan_change",
        purpose: null,
        summary: `${context.summary}: ${approval.title}`,
        metadata: {
          approvalId: approval.id,
          tool: approval.tool,
          reason: context.reason,
        },
      });
    }

    return { cancelled: pending.length };
  } catch (e) {
    console.error("[plan-rails] Error in cancelPendingApprovalsForTools:", e);
    return { cancelled: 0 };
  }
}

/**
 * Get count of pending approvals that would be cancelled for revoked tools.
 *
 * Useful for UI to show impact of a plan downgrade.
 *
 * DEMO mode: returns 0.
 */
export async function countPendingApprovalsForTools(
  orgId: string,
  revokedTools: (GatewayToolId | AdminMcpToolName)[]
): Promise<number> {
  if (isDemoMode()) {
    return 0;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return 0;
  }

  if (revokedTools.length === 0) {
    return 0;
  }

  try {
    const { count, error } = await admin
      .from("approval_requests")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "pending")
      .in("tool", revokedTools);

    if (error) {
      console.error("[plan-rails] Failed to count pending approvals:", error);
      return 0;
    }

    return count ?? 0;
  } catch (e) {
    console.error("[plan-rails] Error in countPendingApprovalsForTools:", e);
    return 0;
  }
}
