import { sendApprovalNotification } from "@/lib/email";
import { sendTransactionalEmail } from "@/lib/resend";
import { buildApprovalNotifyEmail, validateApprovalNotifyEmail } from "@/lib/employees/approval-notify-email";
import { updateApprovalNotificationMessages } from "@/lib/notify/channels";
import type { ApprovalRequest, Employee } from "@/lib/types";
import { deliverAuthorityDecision } from "@/lib/commerce/authority-events";
import { appendAuditEvent } from "@/lib/data/audit";
import { isConfigChangeApproval } from "@/lib/config-change-request/core";
import { recordConfigChangeResolution } from "@/lib/config-change-request/service";
import { isDecisionWorkflowEnabled, isMcpEventsEnabled, isWebhookHardeningEnabled } from "@/lib/feature-flags";
import { categorizeFetchError, categorizeHttpStatus, type WebhookFailureCategory } from "@/lib/webhooks/outbound";
import { withLinkLocalGuard } from "@/lib/webhooks/link-local-guard";
import { deliverHardenedApprovalCallback } from "@/lib/webhooks/approval-callback";
import {
  APPROVAL_WAKE_ACTION,
  isMcpHandoffSurface,
  withMcpHandoff,
  type McpHandoffSurface,
} from "@/lib/mcp/endpoint-handoff";
import { isDecisionRequest } from "@/lib/decision-workflow/notify";
import {
  recordDecisionResult,
  generateDecisionMinutes,
  formatMinutesAsMarkdown,
  type DecisionResult,
  type DecisionMinutes,
} from "@/lib/decision-workflow/result";

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
  /**
   * Approver-facing: a failure CATEGORY only (lib/webhooks/outbound.ts) — never
   * raw error text, the receiver's HTTP status or its body (D9, flag ON and OFF).
   */
  callback: { ok: boolean; skipped?: boolean; error?: WebhookFailureCategory };
  telegram: { ok: boolean; skipped?: boolean; error?: string };
  notifications: Array<{ ok: boolean; provider: string; error?: string }>;
  authorityEvent: {
    ok: boolean;
    skipped?: boolean;
    eventId?: string;
    status?: number | null;
    error?: string;
  };
  decisionResult?: {
    ok: boolean;
    skipped?: boolean;
    result?: DecisionResult;
    minutes?: DecisionMinutes;
    error?: string;
  };
};

/**
 * Best-effort notifications after approve/reject/revision request.
 * Never throws — resolve API must succeed even if notify/callback fails.
 */

/** Fallback when a caller did not pass surface (actor prefix is set by each webhook). */
function inferSurface(actorEmail: string): McpHandoffSurface {
  const prefix = actorEmail.split(":")[0];
  return isMcpHandoffSurface(prefix) ? prefix : "web";
}

export async function runApprovalResolveSideEffects(opts: {
  approval: ApprovalRequest;
  decision: "approved" | "rejected" | "revision_requested";
  actorEmail: string;
  employee?: Employee | null;
  /** Channel the human decided on (Slack / LINE / Telegram / Web / proxy). Used for MCP handoff. */
  surface?: McpHandoffSurface;
}): Promise<ResolveSideEffectsResult> {
  const { approval, decision, actorEmail, employee } = opts;
  const title = approval.title || approval.summary.slice(0, 80);
  const statusLabel = decision;

  // config.change_request: audit reject/revision (nothing applied) and build the
  // polite requester notice the AI relays through the gateway. No-op otherwise.
  const configChange = isConfigChangeApproval(approval)
    ? await recordConfigChangeResolution({ approval, decision, actorEmail })
    : null;

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
  // Members-only recipient (2026-10-09): re-checked right before sending. A
  // non-member (removed since, or written before the rule) is not sent to and
  // the audit row carries IDs only — never the address.
  const configured = employee?.approvalNotifyEmail?.trim();
  if (configured) {
    try {
      const check = await validateApprovalNotifyEmail(employee?.orgId ?? approval.orgId, configured);
      if (!check.ok || !check.email) {
        const reason = check.ok ? "approval_notify_email_invalid" : check.code;
        employeeEmail = { ok: false, skipped: true, error: reason };
        await appendAuditEvent({
          orgId: approval.orgId,
          employeeId: approval.employeeId,
          credentialId: null,
          action: "notification.delivery_failed",
          purpose: "approval_notify_email.recipient_not_member",
          summary: "承認結果メールを送らなかった（通知先がこの組織の有効なメンバーではない）",
          metadata: { approvalId: approval.id, employeeId: approval.employeeId, reason },
        }).catch(() => undefined);
      } else {
        const mail = buildApprovalNotifyEmail();
        employeeEmail = await sendTransactionalEmail({
          to: check.email,
          template: "approval_resolved",
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          tags: [{ name: "template", value: "approval_resolved_member" }],
        });
      }
    } catch (e) {
      employeeEmail = {
        ok: false,
        error: e instanceof Error ? e.message : "employee_email_failed",
      };
    }
  }

  // MCP Events (flag MCP_EVENTS_ENABLED): one channel-independent emit for every
  // decision surface (Web / Slack / LINE / Telegram / proxy all land here).
  // Enqueue is awaited; the signed delivery runs in the background. The same
  // eventId is added to the legacy callback below so a receiver can dedupe.
  let mcpEventId: string | null = null;
  if (isMcpEventsEnabled()) {
    try {
      const { emitApprovalEvent } = await import("@/lib/mcp-events/service");
      mcpEventId = (await emitApprovalEvent({ approval, name: "approval.decided" })).eventId;
    } catch {
      mcpEventId = null;
    }
  }

  let callback: ResolveSideEffectsResult["callback"] = {
    ok: true,
    skipped: true,
  };
  const callbackUrl = employee?.callbackUrl?.trim();
  let handoffSurface: McpHandoffSurface = "web";
  let handoffAttached = false;
  if (callbackUrl) {
    // D9: WEBHOOK_HARDENING_ENABLED OFF → the request below is exactly today's
    // (fetch, same headers / body). ON → lib/webhooks/approval-callback.ts
    // (#267 postWebhook: https:443, public answers only, pinned, no redirects;
    // Standard Webhooks signature; minimal body unless the config opts in).
    const hardened = isWebhookHardeningEnabled();
    let failure: WebhookFailureCategory | null = null;
    try {
      const basePayload = {
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
        ...(configChange?.requesterNoticeJa
          ? { requesterNoticeJa: configChange.requesterNoticeJa }
          : {}),
        ...(mcpEventId ? { eventId: mcpEventId } : {}),
      };
      // Shared, channel-independent MCP endpoint handoff (flag OFF → same object).
      handoffSurface = opts.surface ?? inferSurface(actorEmail);
      const payload = await withMcpHandoff(basePayload, {
        orgId: approval.orgId,
        employeeId: approval.employeeId,
        surface: handoffSurface,
        kind: "approval_resolved",
        trigger: statusLabel,
      });
      handoffAttached = Boolean(payload.mcpHandoff);
      if (hardened) {
        failure = await deliverHardenedApprovalCallback({
          url: callbackUrl,
          orgId: approval.orgId,
          employeeId: approval.employeeId,
          approvalId: approval.id,
          status: statusLabel,
          resolvedAt: approval.resolvedAt,
          eventId: mcpEventId,
          payload: payload as Record<string, unknown>,
        });
      } else {
        // No flag: link-local / cloud-metadata destinations are refused at
        // connect time on every hop (lib/webhooks/link-local-guard.ts).
        const res = await fetch(callbackUrl, withLinkLocalGuard({
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Staffpass-ApprovalHook/1.0",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(4000),
        }));
        failure = categorizeHttpStatus(res.status);
      }
    } catch (e) {
      failure = hardened ? "connection_failed" : categorizeFetchError(e);
    }
    callback = failure ? { ok: false, skipped: false, error: failure } : { ok: true, skipped: false };
    if (handoffAttached) {
      // Wake audit for the shared not-connected watcher (only when the block was sent).
      await appendAuditEvent({
        orgId: approval.orgId,
        employeeId: approval.employeeId,
        credentialId: null,
        action: APPROVAL_WAKE_ACTION,
        purpose: "approval.resolved",
        summary: callback.ok
          ? "承認結果で社員を起こした（MCP handoff 付き）"
          : "承認結果の起こす callback に失敗",
        metadata: {
          reason: callback.ok ? "woke" : "wake_failed",
          ...(failure ? { category: failure } : {}),
          ...(hardened ? { hardened: true } : {}),
          approvalId: approval.id,
          decision: statusLabel,
          surface: handoffSurface,
          mcpHandoff: true,
        },
      }).catch(() => undefined);
    }
  }

  const notifications = await updateApprovalNotificationMessages(
    approval,
    decision,
    actorEmail,
    employee
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

  let decisionResult: ResolveSideEffectsResult["decisionResult"] = {
    ok: true,
    skipped: true,
  };

  if (
    isDecisionWorkflowEnabled() &&
    isDecisionRequest(approval) &&
    (decision === "approved" || decision === "rejected")
  ) {
    try {
      const metadata = approval.metadata as Record<string, unknown>;
      const tier = metadata.tier as "T1" | "T2" | "T3";
      const votes = (metadata.votes as unknown[]) ?? [];
      const totalVoters =
        typeof metadata.totalVoters === "number" ? metadata.totalVoters : 0;
      const approvedCount =
        typeof metadata.approvedCount === "number" ? metadata.approvedCount : 0;
      const rejectedCount =
        typeof metadata.rejectedCount === "number" ? metadata.rejectedCount : 0;
      const quorumRequired =
        metadata.quorumRequired === "all"
          ? ("all" as const)
          : typeof metadata.quorumRequired === "number"
            ? metadata.quorumRequired
            : 1;
      const deadlineAt = metadata.deadlineAt
        ? new Date(metadata.deadlineAt as string)
        : null;

      const progressState = {
        approvalId: approval.id,
        tier,
        status: decision as "approved" | "rejected",
        votes: votes.map((v: unknown) => {
          const vote = v as Record<string, unknown>;
          return {
            voterId: String(vote.voterId || ""),
            vote: (vote.vote as "approve" | "reject" | "abstain") || "abstain",
            votedAt: vote.votedAt ? new Date(vote.votedAt as string) : new Date(),
          };
        }),
        approvedCount,
        rejectedCount,
        pendingCount: Math.max(0, totalVoters - approvedCount - rejectedCount),
        totalVoters,
        quorumRequired,
        quorumMet:
          quorumRequired === "all"
            ? approvedCount === totalVoters
            : approvedCount >= quorumRequired,
        deadlineAt,
        createdAt: new Date(approval.createdAt),
        updatedAt: new Date(),
      };

      const result = recordDecisionResult(progressState, {
        orgId: approval.orgId,
        requesterId: approval.employeeId,
        title: approval.title,
        summary: approval.summary,
        amountJpy: metadata.amountJpy as number | undefined,
        taxExcludedAmountJpy: metadata.taxExcludedAmountJpy as number | undefined,
        category: metadata.category as string | undefined,
        fiscalYear: (metadata.fiscalYear as string) || "",
      });

      const minutes = generateDecisionMinutes(result);
      result.minutes = minutes;

      await appendAuditEvent({
        orgId: approval.orgId,
        employeeId: approval.employeeId,
        credentialId: approval.credentialId,
        action: "decision.resolved",
        purpose: approval.purpose,
        summary: `決裁${decision === "approved" ? "承認" : "却下"}: ${tier} ${approval.title}`,
        actorEmail,
        metadata: {
          approvalId: approval.id,
          tier,
          status: decision,
          approvedCount: result.approvedCount,
          rejectedCount: result.rejectedCount,
          totalVoters: result.totalVoters,
          quorumRequired: result.quorumRequired,
          fiscalYear: result.fiscalYear,
          documentId: minutes.documentId,
        },
      });

      decisionResult = {
        ok: true,
        skipped: false,
        result,
        minutes,
      };
    } catch (error) {
      decisionResult = {
        ok: false,
        skipped: false,
        error: error instanceof Error ? error.message : "decision_result_failed",
      };
    }
  }

  return {
    orgEmail,
    employeeEmail,
    callback,
    telegram,
    notifications,
    authorityEvent,
    decisionResult,
  };
}
