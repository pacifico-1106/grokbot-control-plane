import { sendApprovalNotification } from "@/lib/email";
import { sendTransactionalEmail, renderStubHtml } from "@/lib/resend";
import type { ApprovalRequest, Employee } from "@/lib/types";

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
};

/**
 * Best-effort notifications after approve/reject.
 * Never throws — resolve API must succeed even if notify/callback fails.
 */
export async function runApprovalResolveSideEffects(opts: {
  approval: ApprovalRequest;
  decision: "approved" | "rejected";
  actorEmail: string;
  employee?: Employee | null;
}): Promise<ResolveSideEffectsResult> {
  const { approval, decision, actorEmail, employee } = opts;
  const title = approval.title || approval.summary.slice(0, 80);
  const statusLabel = decision === "approved" ? "approved" : "rejected";

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

  return { orgEmail, employeeEmail, callback };
}
