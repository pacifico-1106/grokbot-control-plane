import { getApprovalById, getEmployee } from "@/lib/data";
import {
  sendApprovalNotifications,
  type NotificationDispatchResult,
} from "@/lib/notify/channels";
import { channelErrorPayload } from "@/lib/notify/channel-errors";

export type PublicNotifyResult = {
  ok: boolean;
  provider: "telegram" | "line" | "slack";
  channelId?: string;
  fallback?: boolean;
  skipped?: boolean;
  error?: string;
};

function publicNotifyResult(row: NotificationDispatchResult): PublicNotifyResult {
  const out: PublicNotifyResult = {
    ok: row.ok,
    provider: row.provider,
  };
  if (row.channelId) out.channelId = row.channelId;
  if (row.fallback) out.fallback = true;
  if (row.skipped) out.skipped = true;
  if (row.error) out.error = row.error;
  return out;
}

/**
 * Re-send the approval inbox card for a pending ticket.
 * Does not resolve, invoke the gateway, or change status.
 */
export async function resendPendingApprovalNotifications(
  id: string,
  orgId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const approval = await getApprovalById(id, orgId);
  if (!approval) {
    return { status: 404, body: channelErrorPayload("approval_not_found") };
  }
  if (approval.status !== "pending") {
    return { status: 409, body: channelErrorPayload("approval_not_pending") };
  }

  const employee = await getEmployee(approval.employeeId, orgId);
  const results = await sendApprovalNotifications(approval, employee);
  return {
    status: 200,
    body: {
      ok: true,
      results: results.map(publicNotifyResult),
    },
  };
}
