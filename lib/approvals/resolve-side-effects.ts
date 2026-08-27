import { sendApprovalNotification } from "@/lib/email";
import { sendTransactionalEmail, renderStubHtml } from "@/lib/resend";
import { updateApprovalNotificationMessages } from "@/lib/notify/channels";
import type { ApprovalRequest, Employee } from "@/lib/types";
import { deliverAuthorityDecision } from "@/lib/commerce/authority-events";
import { appendAuditEvent } from "@/lib/data/audit";

function orgNotifyEmail(): string {
  return (
    process.env.BILLING_NOTIFY_EMAIL ||
    process.env.APPROVAL_NOTIFY_EMAIL ||
    "owner@example.com"
  );
}

export type ResolveSideEffectsResult = {
  orgEmail: { ok: boolean; stub?: boolean; error?: string };
  employeeEmail: { ok: boolean; stub?: boolean; skipped?: boolean; error?: string };
  callback: { ok: boolean; skipped?: boolean; status?: number; error?: string };
  telegram: { ok: boolean; skipped?: boolean; error?: string };
  notifications: Array<{ ok: boolean; provider: string; error?: string }>;
  authorityEvent: {
    ok: boolean;
    skipped?: boolean;
    eventId?: string;
    status?: number | null;
    error?: string;
  };
};

/**
 * Best-effort notifications after approve/reject/revision request.
 * Never throws — resolve API must succeed even if notify/callback fails.
 */
export async function runApprovalResolveSideEffects(opts: {
  approval: ApprovalRequest;
  decision: "approved" | "rejected" | "revision_requested";
  actorEmail: string;
  employee?: Employee | null;
}): Promise<ResolveSideEffectsResult> {
  const { approval, decision, actorEmail, employee } = opts;
  const title = approval.title || approval.summary.slice(0, 80);
  const statusLabel = decision;

  let orgEmail: ResolveSideEffectsResult["orgEmail"] = { ok: false };
  try {
    orgEmail = await sendApprovalNotification(
      orgNotifyEmail(),
      "approval_resolved",
      `${title}<br/>処理者: ${actorEmail}`,
      approval.risk,
      statusLabel
    );
  } catch (e) {
    orgEmail = {
      ok: false,
      error: e instanceof Error ? e.message : "org_email_failed",
    };
  }

  let employeeEmail: ResolveSideEffectsResult["employeeEmail"] = {
    ok: true,
    skipped: true,
  };
  const notifyTo = employee?.approvalNotifyEmail?.trim();
  if (notifyTo) {
    try {
      const machineBody = [
        `status=${statusLabel}`,
        `approvalId=${approval.id}`,
        `employeeId=${approval.employeeId}`,
        `tool=${approval.tool ?? ""}`,
        `jobId=${approval.jobId ?? ""}`,
        `purpose=${approval.purpose}`,
        `risk=${approval.risk}`,
        `resolvedBy=${actorEmail}`,
        ...(approval.revisionNote
          ? [`revisionNote=${approval.revisionNote.replace(/\n/g, " | ")}`]
          : []),
        `revisionCount=${approval.revisionCount}`,
        `summary=${approval.summary.replace(/\n/g, " | ")}`,
      ].join("\n");
      employeeEmail = await sendTransactionalEmail({
        to: notifyTo,
        template: "approval_resolved",
        subject: `[AI社員] approval ${statusLabel}: ${approval.id}`,
        text: machineBody,
        html: renderStubHtml(
          `承認結果: ${statusLabel}`,
          `<pre style="white-space:pre-wrap;font-size:12px">${machineBody}</pre>`
        ),
        tags: [
          { name: "template", value: "approval_resolved_machine" },
          { name: "approval_id", value: approval.id.slice(0, 48) },
        ],
      });
    } catch (e) {
      employeeEmail = {
        ok: false,
        error: e instanceof Error ? e.message : "employee_email_failed",
      };
    }
  }

  let callback: ResolveSideEffectsResult["callback"] = {
    ok: true,
    skipped: true,
  };
  const callbackUrl = employee?.callbackUrl?.trim();
  if (callbackUrl) {
    try {
      const payload = {
        type: "approval.resolved",
        status: statusLabel,
        approvalId: approval.id,
        employeeId: approval.employeeId,
        tool: approval.tool ?? null,
        jobId: approval.jobId ?? null,
        purpose: approval.purpose,
        risk: approval.risk,
        title,
        summary: approval.summary,
        resolvedBy: actorEmail,
        resolvedAt: approval.resolvedAt,
        revisionNote: approval.revisionNote,
        revisionCount: approval.revisionCount,
        parentApprovalId: approval.parentApprovalId,
      };
      const res = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Staffpass-ApprovalHook/1.0",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });
      callback = { ok: res.ok, status: res.status, skipped: false };
    } catch (e) {
      callback = {
        ok: false,
        skipped: false,
        error: e instanceof Error ? e.message : "callback_failed",
      };
    }
  }

  const notifications = await updateApprovalNotificationMessages(
    approval,
    decision,
    actorEmail
  ).catch((error) => [{
    ok: false,
    provider: "unknown",
    error: error instanceof Error ? error.message : "notification_update_failed",
  }]);

  const telegram = notifications.find((item) => item.provider === "telegram") ?? {
    ok: false,
    skipped: true,
  };
  const authorityEvent: ResolveSideEffectsResult["authorityEvent"] =
    decision === "approved" || decision === "rejected"
      ? await deliverAuthorityDecision({
          approval,
          decision,
          actorEmail,
          employee,
        }).catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : "authority_event_failed",
        }))
      : { ok: true, skipped: true };
  if (approval.metadata.crossProductCommerce) {
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId: approval.employeeId,
      credentialId: approval.credentialId,
      action: "authority.event_delivery",
      purpose: approval.purpose,
      summary: authorityEvent.ok
        ? authorityEvent.skipped
          ? "Sealith authority event: disabled"
          : "Sealith authority event: delivered"
        : "Sealith authority event: delivery pending",
      actorEmail,
      metadata: {
        jobId: approval.jobId,
        approvalId: approval.id,
        targetSystem: "sealith",
        authorityMode: "external_reference",
        eventId: authorityEvent.eventId ?? null,
        deliveryStatus: authorityEvent.skipped
          ? "disabled"
          : authorityEvent.ok
            ? "delivered"
            : "retryable",
        httpStatus: authorityEvent.status ?? null,
        error: authorityEvent.error ?? null,
      },
    });
  }
  return {
    orgEmail,
    employeeEmail,
    callback,
    telegram,
    notifications,
    authorityEvent,
  };
}
