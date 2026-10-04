/**
 * F7 stuck watch item aggregation for Admin MCP list/inspect.
 */
import { listApprovals } from "@/lib/data";
import { readCardAttachment } from "@/lib/approvals/attachment-card";
import { attachmentUncertainItemId, readAttachmentUpload } from "@/lib/approvals/attachment-upload-claim";
import { isMentionWakeAudit, listAuditEventsForStuckWatch } from "@/lib/data/audit";
import { getOrgStuckWatchPolicy } from "@/lib/data/stuck-watch-policy";
import { isDecisionWorkflowEnabled } from "@/lib/feature-flags";
import {
  checkDecisionStalled,
  shouldAutoExpire,
  type DecisionProgressState,
} from "@/lib/decision-workflow/progress";
import {
  hasSuccessfulReplyAfterWake,
  inferW1BlockingContext,
  w1ItemId,
} from "@/lib/stuck-watch/w1-mention-unanswered";
import {
  evaluateW2Eligibility,
  isApprovedUnfulfilled,
  w2ManualReinvokeNextStepJa,
  w2ManualReinvokeOnlyTool,
} from "@/lib/stuck-watch/w2-unfulfilled";
import type {
  AuditEvent,
  ApprovalRequest,
  FaultClass,
  StuckHint,
  StuckWatchItem,
  StuckWatchKind,
} from "@/lib/types";

function stuckWatchStateFromAudits(audits: AuditEvent[]) {
  const resolved = new Map<string, string>();
  const notified = new Map<string, string>();
  for (const audit of audits) {
    const itemId =
      typeof audit.metadata?.itemId === "string" ? audit.metadata.itemId : "";
    if (!itemId) continue;
    if (audit.action === "stuck_watch.resolve") {
      resolved.set(itemId, audit.createdAt);
    }
    if (audit.action === "stuck_watch.w1_notify") {
      notified.set(itemId, audit.createdAt);
    }
  }
  return { resolved, notified };
}

function w2ItemId(approvalId: string): string {
  return `w2:${approvalId}`;
}

function summarizeW1Ja(
  wake: AuditEvent,
  blocking: { faultClass: FaultClass; code: string }
): string {
  const channel = String(wake.metadata?.channel || "—");
  return `W1 メンション未返信: channel=${channel} / faultClass=${blocking.faultClass} / code=${blocking.code}`;
}

function nextStepW1Ja(faultClass: FaultClass, code?: string): string {
  if (faultClass === "expected_gate") {
    return "正当ゲート（承認待ち等）のため自動再発火しません。承認を進めるか stuckWatch.resolve で解決済みにしてください。";
  }
  if (faultClass === "config_drift") {
    const isAudienceRelated = code === "egress_denied";
    if (isAudienceRelated) {
      return "audience 台帳設定が不足しています。(1) channels.classify で shared_external + mixed=true を設定、(2) parties.upsert で speaker を内部登録、または (3) internalAudienceRule.patch を設定。修正後 stuckWatch.retry を検討してください。";
    }
    return "設定不足（台帳・スコープ等）です。parties.upsert / internalAudienceRule.patch で修正後、stuckWatch.retry を検討してください。";
  }
  return "ops_fault です。stuckWatch.retry で再試行できます（ゲートは再評価されます）。notifyMouth 通知も確認してください。";
}

function summarizeW2Ja(approval: ApprovalRequest): string {
  return `W2 承認後未fulfill: ${approval.tool} / jobId=${approval.jobId} / approvalId=${approval.id.slice(0, 8)}`;
}

function nextStepW2Ja(faultClass: FaultClass = "ops_fault"): string {
  if (faultClass === "expected_gate") {
    return "正当ゲートのため自動再発火しません。";
  }
  return "stuckWatch.retry で fulfill 再実行できます（最大2回・既存 #53 パス）。";
}

function buildW1Item(
  wake: AuditEvent,
  audits: AuditEvent[],
  approvals: ApprovalRequest[],
  policyMinutes: number,
  resolved: Map<string, string>,
  notified: Map<string, string>,
  now: Date
): StuckWatchItem | null {
  const channel = String(wake.metadata?.channel || "");
  const ts = String(wake.metadata?.ts || "");
  if (!channel || !ts) return null;
  const itemId = w1ItemId(channel, ts);
  const blocking = inferW1BlockingContext(wake, audits, approvals);
  if (hasSuccessfulReplyAfterWake(wake, audits, approvals)) return null;
  const wakeTime = new Date(wake.createdAt);
  const minutesOpen = Math.max(0, (now.getTime() - wakeTime.getTime()) / 60_000);
  if (minutesOpen < policyMinutes) return null;

  const resolvedAt = resolved.get(itemId);
  const notifiedAt = notified.get(itemId);
  const status = resolvedAt ? "resolved" : notifiedAt ? "notified" : "open";

  return {
    id: itemId,
    orgId: wake.orgId,
    kind: "w1_mention_unanswered",
    employeeId: wake.employeeId,
    jobId: blocking.jobId,
    approvalId: blocking.approvalId,
    tool: blocking.tool,
    faultClass: blocking.faultClass,
    stuckHint: blocking.stuckHint,
    code: blocking.code,
    status,
    detectedAt: wake.createdAt,
    notifiedAt: notifiedAt ?? null,
    resolvedAt: resolvedAt ?? null,
    minutesOpen: Math.floor(minutesOpen),
    summaryJa: summarizeW1Ja(wake, blocking),
    nextStepJa: nextStepW1Ja(blocking.faultClass, blocking.code),
    metadata: {
      channel,
      mentionTs: ts,
      threadTs: wake.metadata?.thread_ts,
      eventId: wake.metadata?.eventId,
      wakeAction: wake.action,
    },
  };
}

function buildW2Item(
  approval: ApprovalRequest,
  policy: { approvedUnfulfilledMinutes: number; maxAutoRetries: number; enabled: boolean },
  resolved: Map<string, string>,
  now: Date
): StuckWatchItem | null {
  if (!isApprovedUnfulfilled(approval)) return null;
  const eligibility = evaluateW2Eligibility({
    approval,
    policy: {
      version: 1,
      enabled: policy.enabled,
      mentionUnansweredMinutes: 15,
      approvedUnfulfilledMinutes: policy.approvedUnfulfilledMinutes,
      maxAutoRetries: policy.maxAutoRetries,
      retryBackoffSeconds: 60,
      autoRetryFaultClasses: ["ops_fault"],
      inferInternalAudienceFromLedger: true,
      updatedAt: now.toISOString(),
      updatedBy: "system",
    },
    now,
  });
  const itemId = w2ItemId(approval.id);
  const resolvedAt = resolved.get(itemId);
  const minutesOpen = approval.resolvedAt
    ? Math.max(
        0,
        (now.getTime() - new Date(approval.resolvedAt).getTime()) / 60_000
      )
    : 0;
  if (!resolvedAt && !eligibility.eligible && eligibility.reason === "too_soon") {
    return null;
  }

  const status = resolvedAt ? "resolved" : "open";
  const faultClass: FaultClass = "ops_fault";
  // Excluded from W2 auto retry → needs a person (explicit re-invoke).
  const manualTool = eligibility.reason === "manual_reinvoke_required" ? w2ManualReinvokeOnlyTool(approval) : null;
  const stuckHint: StuckHint = manualTool ? "fix" : "retryable";

  return {
    id: itemId,
    orgId: approval.orgId,
    kind: "w2_approved_unfulfilled",
    employeeId: approval.employeeId,
    jobId: approval.jobId,
    approvalId: approval.id,
    tool: approval.tool,
    faultClass,
    stuckHint,
    code: "approved_unfulfilled",
    status,
    detectedAt: approval.resolvedAt || approval.createdAt,
    notifiedAt: null,
    resolvedAt: resolvedAt ?? null,
    minutesOpen: Math.floor(minutesOpen),
    summaryJa: summarizeW2Ja(approval),
    nextStepJa: manualTool ? w2ManualReinvokeNextStepJa(manualTool) : nextStepW2Ja(faultClass),
    metadata: {
      retryCount: eligibility.retryCount,
      w2Eligible: eligibility.eligible,
      w2Reason: eligibility.reason,
    },
  };
}

function d1ItemId(approvalId: string): string {
  return `d1:${approvalId}`;
}

function isDecisionApproval(approval: ApprovalRequest): boolean {
  const metadata = approval.metadata as Record<string, unknown> | null;
  return metadata?.type === "decision_request" && !!metadata?.tier;
}

function extractDecisionProgress(
  approval: ApprovalRequest,
  now: Date
): DecisionProgressState | null {
  const metadata = approval.metadata as Record<string, unknown> | null;
  if (!metadata?.tier) return null;

  const tier = metadata.tier as "T1" | "T2" | "T3";
  const votes = (metadata.votes as unknown[]) ?? [];
  const approvedCount =
    typeof metadata.approvedCount === "number" ? metadata.approvedCount : 0;
  const rejectedCount =
    typeof metadata.rejectedCount === "number" ? metadata.rejectedCount : 0;
  const totalVoters =
    typeof metadata.totalVoters === "number" ? metadata.totalVoters : 0;
  const quorumRequired =
    metadata.quorumRequired === "all"
      ? ("all" as const)
      : typeof metadata.quorumRequired === "number"
        ? metadata.quorumRequired
        : 1;
  const deadlineAt = metadata.deadlineAt
    ? new Date(metadata.deadlineAt as string)
    : null;

  return {
    approvalId: approval.id,
    tier,
    status:
      approval.status === "pending"
        ? "pending"
        : approval.status === "approved"
          ? "approved"
          : approval.status === "rejected"
            ? "rejected"
            : "pending",
    votes: votes.map((v: unknown) => {
      const vote = v as Record<string, unknown>;
      return {
        voterId: String(vote.voterId || ""),
        vote: (vote.vote as "approve" | "reject" | "abstain") || "abstain",
        votedAt: vote.votedAt ? new Date(vote.votedAt as string) : now,
      };
    }),
    approvedCount,
    rejectedCount,
    pendingCount: Math.max(0, totalVoters - approvedCount - rejectedCount),
    totalVoters,
    quorumRequired,
    quorumMet: quorumRequired === "all" ? approvedCount === totalVoters : approvedCount >= quorumRequired,
    deadlineAt,
    createdAt: new Date(approval.createdAt),
    updatedAt: new Date(approval.resolvedAt ?? approval.createdAt),
  };
}

function buildD1Item(
  approval: ApprovalRequest,
  resolved: Map<string, string>,
  now: Date
): StuckWatchItem | null {
  if (!isDecisionWorkflowEnabled()) return null;
  if (!isDecisionApproval(approval)) return null;
  if (approval.status !== "pending") return null;

  const progressState = extractDecisionProgress(approval, now);
  if (!progressState) return null;

  const stalledItem = checkDecisionStalled(progressState, now);
  if (!stalledItem) return null;

  const itemId = d1ItemId(approval.id);
  const resolvedAt = resolved.get(itemId);
  const minutesOpen = Math.floor(
    (now.getTime() - new Date(approval.createdAt).getTime()) / 60_000
  );

  const status = resolvedAt ? "resolved" : "open";
  const faultClass: FaultClass = "expected_gate";
  const stuckHint: StuckHint =
    stalledItem.reason === "quorum_unreachable" ? "fix" : "retryable";

  const willAutoExpire = shouldAutoExpire(progressState, now);

  return {
    id: itemId,
    orgId: approval.orgId,
    kind: "d1_decision_stalled",
    employeeId: approval.employeeId,
    jobId: approval.jobId,
    approvalId: approval.id,
    tool: approval.tool,
    faultClass,
    stuckHint,
    code: stalledItem.reason,
    status,
    detectedAt: approval.createdAt,
    notifiedAt: null,
    resolvedAt: resolvedAt ?? null,
    minutesOpen,
    summaryJa: stalledItem.summaryJa,
    nextStepJa: stalledItem.nextStepJa,
    metadata: {
      tier: stalledItem.tier,
      reason: stalledItem.reason,
      daysSinceCreation: stalledItem.daysSinceCreation,
      progress: stalledItem.progress,
      deadlineAt: stalledItem.deadlineAt?.toISOString() ?? null,
      willAutoExpire,
    },
  };
}

/**
 * A1 (#253 follow-up): the scheduled reconcile could not check whether the
 * approved attachment was shared, and told the admin agent (adminNotifiedAt on
 * metadata.attachmentUpload, written once by the reconcile). Built from the
 * approval record itself, so it disappears as soon as a later reconcile
 * settles the claim. Only this Admin MCP list carries it — no human channel.
 */
const A1_CONFIG_CODES = /^reconcile_(token_|slack_(missing_scope|invalid_auth|not_authed|account_inactive|token_revoked|token_expired|not_in_channel|channel_not_found|no_permission)$|destination_unsupported$|thread_missing$)/;

function nextStepA1Ja(code: string): string {
  if (/^reconcile_(token_|slack_(invalid_auth|not_authed|account_inactive|token_revoked|token_expired)$)/.test(code)) {
    return "会話用 Slack トークンを確認できません。会話アダプタ（Slack Bot トークン）を接続し直すと、次回の定期確認で自動的に確定します。手作業での再送・SQL 修正はしないでください。";
  }
  if (code === "reconcile_slack_missing_scope" || code === "reconcile_slack_no_permission") {
    return "会話用 Slack トークンに履歴読み取り権限（channels:history / groups:history / im:history / mpim:history）がありません。権限を追加すると次回の定期確認で自動的に確定します。";
  }
  if (code === "reconcile_slack_not_in_channel" || code === "reconcile_slack_channel_not_found") {
    return "承認された宛先チャンネルを Bot が読めません。Bot をチャンネルに追加すると次回の定期確認で自動的に確定します。";
  }
  if (code === "reconcile_ambiguous_match" || code === "reconcile_file_details_hidden") {
    return "同名・同サイズ等の紛らわしいファイルがあり、自動では一意に判定できません。二重送信を防ぐため自動再送しません。対応を決めたら stuckWatch.resolve で解決済みにしてください。";
  }
  if (code === "reconcile_surface_unsupported" || code === "reconcile_destination_unsupported") {
    return "この宛先は自動照合に未対応です。二重送信を防ぐため自動再送しません。対応を決めたら stuckWatch.resolve で解決済みにしてください。";
  }
  return "一時的に確認できませんでした（Slack 応答エラー等）。定期確認が自動で再確認します（通知はこの1回のみ）。";
}

function buildA1Item(
  approval: ApprovalRequest,
  resolved: Map<string, string>,
  now: Date
): StuckWatchItem | null {
  const upload = readAttachmentUpload(approval.metadata);
  if (upload?.state !== "uncertain" || !upload.adminNotifiedAt) return null;
  const itemId = attachmentUncertainItemId(approval.id);
  const resolvedAt = resolved.get(itemId);
  const code = upload.code || "reconcile_unknown";
  const card = readCardAttachment(approval.metadata);
  return {
    id: itemId,
    orgId: approval.orgId,
    kind: "a1_attachment_uncertain",
    employeeId: approval.employeeId,
    jobId: approval.jobId,
    approvalId: approval.id,
    tool: approval.tool,
    faultClass: A1_CONFIG_CODES.test(code) ? "config_drift" : "ops_fault",
    stuckHint: "fix",
    code,
    status: resolvedAt ? "resolved" : "notified",
    detectedAt: upload.adminNotifiedAt,
    notifiedAt: upload.adminNotifiedAt,
    resolvedAt: resolvedAt ?? null,
    minutesOpen: Math.max(0, Math.floor((now.getTime() - Date.parse(upload.adminNotifiedAt)) / 60_000)),
    summaryJa: `A1 承認済み添付の送信結果を自動確認できません: ${approval.tool} / approvalId=${approval.id.slice(0, 8)} / code=${code}`,
    nextStepJa: nextStepA1Ja(code),
    metadata: {
      ...(card?.kind === "present" ? { filename: card.filename, ...(card.bytes !== undefined ? { bytes: card.bytes } : {}) } : {}),
      claimedAt: upload.claimedAt ?? null,
      reconciledAt: upload.reconciledAt ?? null,
    },
  };
}

export async function listStuckWatchItems(
  orgId: string,
  options?: { includeResolved?: boolean }
): Promise<StuckWatchItem[]> {
  const policy = await getOrgStuckWatchPolicy(orgId);
  const audits = await listAuditEventsForStuckWatch(orgId, 500);
  const approvals = await listApprovals(orgId);
  const { resolved, notified } = stuckWatchStateFromAudits(audits);
  const now = new Date();
  const items: StuckWatchItem[] = [];

  for (const wake of audits) {
    if (!isMentionWakeAudit(wake)) continue;
    const item = buildW1Item(
      wake,
      audits,
      approvals,
      policy.mentionUnansweredMinutes,
      resolved,
      notified,
      now
    );
    if (!item) continue;
    if (!options?.includeResolved && item.status === "resolved") continue;
    items.push(item);
  }

  for (const approval of approvals) {
    const item = buildW2Item(
      approval,
      policy,
      resolved,
      now
    );
    if (!item) continue;
    if (!options?.includeResolved && item.status === "resolved") continue;
    items.push(item);
  }

  for (const approval of approvals) {
    const item = buildA1Item(approval, resolved, now);
    if (!item) continue;
    if (!options?.includeResolved && item.status === "resolved") continue;
    items.push(item);
  }

  for (const approval of approvals) {
    const item = buildD1Item(approval, resolved, now);
    if (!item) continue;
    if (!options?.includeResolved && item.status === "resolved") continue;
    items.push(item);
  }

  return items.sort(
    (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
  );
}

export async function getStuckWatchItem(
  orgId: string,
  itemId: string
): Promise<StuckWatchItem | null> {
  const items = await listStuckWatchItems(orgId, { includeResolved: true });
  return items.find((item) => item.id === itemId) ?? null;
}

export function stuckWatchKindFromItemId(itemId: string): StuckWatchKind | null {
  if (itemId.startsWith("w1:")) return "w1_mention_unanswered";
  if (itemId.startsWith("w2:")) return "w2_approved_unfulfilled";
  if (itemId.startsWith("d1:")) return "d1_decision_stalled";
  if (itemId.startsWith("a1:")) return "a1_attachment_uncertain";
  return null;
}
