/**
 * W1: mention-unanswered watch — detect Slack/mention jobs without a successful reply.
 * Notifies via policy.notifyMouth; does not auto-retry expected_gate.
 */
import { appendAuditEvent, listApprovals } from "@/lib/data";
import { isMentionWakeAudit, listAuditEventsForStuckWatch } from "@/lib/data/audit";
import { getOrgStuckWatchPolicy } from "@/lib/data/stuck-watch-policy";
import { classifyInvokeFailure } from "@/lib/stuck-watch/classify";
import { notifyStuckWatchMouth } from "@/lib/stuck-watch/notify-mouth";
import type {
  AuditEvent,
  ApprovalRequest,
  FaultClass,
  OrgStuckWatchPolicy,
  StuckHint,
} from "@/lib/types";

const REPLY_TOOLS = new Set(["comm.reply", "comm.send", "slack.post"]);

export function w1ItemId(channel: string, ts: string): string {
  return `w1:${channel}:${ts}`;
}

export function hasSuccessfulReplyAfterWake(
  wake: AuditEvent,
  audits: AuditEvent[],
  approvals: ApprovalRequest[]
): boolean {
  const channel = String(wake.metadata?.channel || "").trim();
  if (!channel) return false;
  const wakeTime = new Date(wake.createdAt).getTime();
  const employeeId = wake.employeeId;

  for (const audit of audits) {
    if (audit.employeeId !== employeeId) continue;
    if (new Date(audit.createdAt).getTime() <= wakeTime) continue;
    const tool = String(audit.metadata?.tool || "");
    if (!REPLY_TOOLS.has(tool)) continue;
    const dest = String(
      audit.metadata?.destination ||
        audit.metadata?.channel ||
        (audit.metadata?.conversationDelivery as { channel?: string } | undefined)
          ?.channel ||
        ""
    ).trim();
    if (dest && dest !== channel) continue;
    const code = String(audit.metadata?.code || audit.metadata?.error || "").trim();
    if (code) continue;
    if (audit.action === "slack.post_failed") continue;
    if (audit.action === "tool.invoke" && audit.summary.includes("自動実行")) {
      return true;
    }
    const delivery = audit.metadata?.conversationDelivery;
    if (
      delivery &&
      typeof delivery === "object" &&
      (delivery as { ok?: boolean }).ok === true
    ) {
      return true;
    }
  }

  for (const approval of approvals) {
    if (approval.employeeId !== employeeId) continue;
    if (approval.status !== "approved") continue;
    const resolvedAt = approval.resolvedAt
      ? new Date(approval.resolvedAt).getTime()
      : 0;
    if (resolvedAt <= wakeTime) continue;
    const fulfillment = approval.metadata?.fulfillment;
    if (
      fulfillment &&
      typeof fulfillment === "object" &&
      (fulfillment as { ok?: boolean }).ok === true
    ) {
      const ch = String((fulfillment as { channel?: string }).channel || "").trim();
      if (!ch || ch === channel) return true;
    }
  }

  return false;
}

export type W1BlockingContext = {
  faultClass: FaultClass;
  stuckHint: StuckHint;
  code: string;
  jobId?: string;
  approvalId?: string;
  tool?: string;
};

export function inferW1BlockingContext(
  wake: AuditEvent,
  audits: AuditEvent[],
  approvals: ApprovalRequest[]
): W1BlockingContext {
  const wakeTime = new Date(wake.createdAt).getTime();
  const employeeId = wake.employeeId;

  const pending = approvals.find(
    (row) =>
      row.employeeId === employeeId &&
      row.status === "pending" &&
      new Date(row.createdAt).getTime() >= wakeTime
  );
  if (pending) {
    return {
      faultClass: "expected_gate",
      stuckHint: "wait_approval",
      code: "needs_approval",
      approvalId: pending.id,
      jobId: pending.jobId ?? undefined,
      tool: pending.tool ?? undefined,
    };
  }

  for (const audit of audits) {
    if (audit.employeeId !== employeeId) continue;
    if (new Date(audit.createdAt).getTime() < wakeTime) continue;
    const tool = String(audit.metadata?.tool || "");
    const code = String(audit.metadata?.code || audit.metadata?.error || "");
    if (!code && audit.action !== "tool.invoke" && audit.action !== "slack.post_failed") {
      continue;
    }
    const classified = classifyInvokeFailure({
      code,
      needs_approval: code === "needs_approval",
      egress:
        audit.metadata?.egress && typeof audit.metadata.egress === "object"
          ? (audit.metadata.egress as {
              reason?: string;
              audience?: string;
              effectiveAudience?: string;
            })
          : null,
    });
    return {
      faultClass: classified.faultClass,
      stuckHint: classified.stuckHint,
      code: code || audit.action,
      jobId: typeof audit.metadata?.jobId === "string" ? audit.metadata.jobId : undefined,
      tool: tool || undefined,
    };
  }

  return {
    faultClass: "ops_fault",
    stuckHint: "retryable",
    code: "mention_unanswered",
  };
}

export type W1EligibilityInput = {
  wake: AuditEvent;
  policy: OrgStuckWatchPolicy;
  audits: AuditEvent[];
  approvals: ApprovalRequest[];
  now: Date;
  resolvedItemIds: Set<string>;
  notifiedItemIds: Set<string>;
};

export type W1EligibilityResult = {
  eligible: boolean;
  itemId: string;
  reason?:
    | "disabled"
    | "too_soon"
    | "already_replied"
    | "resolved"
    | "already_notified";
  minutesSinceWake: number;
  blocking: W1BlockingContext;
};

export function evaluateW1Eligibility(input: W1EligibilityInput): W1EligibilityResult {
  const { wake, policy, audits, approvals, now, resolvedItemIds, notifiedItemIds } =
    input;
  const channel = String(wake.metadata?.channel || "");
  const ts = String(wake.metadata?.ts || "");
  const itemId = w1ItemId(channel, ts);
  const wakeTime = new Date(wake.createdAt);
  const minutesSinceWake = Math.max(
    0,
    (now.getTime() - wakeTime.getTime()) / 60_000
  );
  const blocking = inferW1BlockingContext(wake, audits, approvals);

  if (!policy.enabled) {
    return {
      eligible: false,
      itemId,
      reason: "disabled",
      minutesSinceWake,
      blocking,
    };
  }
  if (resolvedItemIds.has(itemId)) {
    return {
      eligible: false,
      itemId,
      reason: "resolved",
      minutesSinceWake,
      blocking,
    };
  }
  if (hasSuccessfulReplyAfterWake(wake, audits, approvals)) {
    return {
      eligible: false,
      itemId,
      reason: "already_replied",
      minutesSinceWake,
      blocking,
    };
  }
  if (minutesSinceWake < policy.mentionUnansweredMinutes) {
    return {
      eligible: false,
      itemId,
      reason: "too_soon",
      minutesSinceWake,
      blocking,
    };
  }
  if (notifiedItemIds.has(itemId)) {
    return {
      eligible: false,
      itemId,
      reason: "already_notified",
      minutesSinceWake,
      blocking,
    };
  }

  return { eligible: true, itemId, minutesSinceWake, blocking };
}

function stuckWatchStateFromAudits(audits: AuditEvent[]) {
  const resolvedItemIds = new Set<string>();
  const notifiedItemIds = new Set<string>();
  for (const audit of audits) {
    const itemId = typeof audit.metadata?.itemId === "string"
      ? audit.metadata.itemId
      : "";
    if (!itemId) continue;
    if (audit.action === "stuck_watch.resolve") {
      resolvedItemIds.add(itemId);
    }
    if (audit.action === "stuck_watch.w1_notify") {
      notifiedItemIds.add(itemId);
    }
  }
  return { resolvedItemIds, notifiedItemIds };
}

export type W1NotifyResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  itemId: string;
  faultClass: FaultClass;
  notified?: boolean;
};

export async function runW1MentionNotify(
  wake: AuditEvent,
  policy?: OrgStuckWatchPolicy
): Promise<W1NotifyResult> {
  const effectivePolicy =
    policy ?? (await getOrgStuckWatchPolicy(wake.orgId));
  const audits = await listAuditEventsForStuckWatch(wake.orgId, 500);
  const approvals = await listApprovals(wake.orgId);
  const { resolvedItemIds, notifiedItemIds } = stuckWatchStateFromAudits(audits);
  const eligibility = evaluateW1Eligibility({
    wake,
    policy: effectivePolicy,
    audits,
    approvals,
    now: new Date(),
    resolvedItemIds,
    notifiedItemIds,
  });

  if (!eligibility.eligible) {
    return {
      ok: false,
      skipped: true,
      reason: eligibility.reason,
      itemId: eligibility.itemId,
      faultClass: eligibility.blocking.faultClass,
    };
  }

  const channel = String(wake.metadata?.channel || "");
  const summaryJa = `W1: メンション未返信（${Math.floor(eligibility.minutesSinceWake)}分） channel=${channel}`;
  const notifyMessage = [
    "⚠️ Staffpass Stuck Watch W1",
    summaryJa,
    `faultClass=${eligibility.blocking.faultClass}`,
    `code=${eligibility.blocking.code}`,
    `employeeId=${wake.employeeId || "—"}`,
    eligibility.blocking.faultClass === "expected_gate"
      ? "正当ゲートのため自動再発火しません。承認または設定確認が必要です。"
      : "Admin MCP stuckWatch.inspect / retry で確認してください。",
  ].join("\n");

  const mouth = await notifyStuckWatchMouth(
    wake.orgId,
    effectivePolicy,
    notifyMessage,
    {
      itemId: eligibility.itemId,
      kind: "w1_mention_unanswered",
      faultClass: eligibility.blocking.faultClass,
      code: eligibility.blocking.code,
    }
  );

  await appendAuditEvent({
    orgId: wake.orgId,
    employeeId: wake.employeeId,
    credentialId: null,
    action: "stuck_watch.w1_notify",
    purpose: "slack.mention",
    summary: summaryJa,
    metadata: {
      itemId: eligibility.itemId,
      kind: "w1_mention_unanswered",
      channel,
      mentionTs: wake.metadata?.ts,
      threadTs: wake.metadata?.thread_ts,
      eventId: wake.metadata?.eventId,
      faultClass: eligibility.blocking.faultClass,
      stuckHint: eligibility.blocking.stuckHint,
      code: eligibility.blocking.code,
      jobId: eligibility.blocking.jobId,
      approvalId: eligibility.blocking.approvalId,
      minutesSinceWake: eligibility.minutesSinceWake,
      notifyMouth: effectivePolicy.notifyMouth,
      mouthDelivered: mouth.ok && !mouth.skipped,
      mouthSkipped: mouth.skipped,
      mouthError: mouth.error,
      nextAction:
        eligibility.blocking.faultClass === "expected_gate"
          ? "wait_approval"
          : "inspect_or_retry",
    },
  }).catch(() => undefined);

  return {
    ok: true,
    itemId: eligibility.itemId,
    faultClass: eligibility.blocking.faultClass,
    notified: mouth.ok || mouth.skipped,
  };
}

export async function processW1MentionWatchForOrg(
  orgId: string
): Promise<W1NotifyResult[]> {
  const policy = await getOrgStuckWatchPolicy(orgId);
  if (!policy.enabled) return [];

  const audits = await listAuditEventsForStuckWatch(orgId, 500);
  const approvals = await listApprovals(orgId);
  const { resolvedItemIds, notifiedItemIds } = stuckWatchStateFromAudits(audits);
  const now = new Date();
  const results: W1NotifyResult[] = [];

  for (const wake of audits) {
    if (!isMentionWakeAudit(wake)) continue;
    const eligibility = evaluateW1Eligibility({
      wake,
      policy,
      audits,
      approvals,
      now,
      resolvedItemIds,
      notifiedItemIds,
    });
    if (!eligibility.eligible) continue;
    results.push(await runW1MentionNotify(wake, policy));
  }

  return results;
}

export async function processW1MentionWatchAllOrgs(): Promise<W1NotifyResult[]> {
  const audits = await listAuditEventsForStuckWatch(null, 500);
  const orgIds = new Set<string>();
  for (const audit of audits) {
    if (isMentionWakeAudit(audit)) {
      orgIds.add(audit.orgId);
    }
  }
  const results: W1NotifyResult[] = [];
  for (const orgId of orgIds) {
    results.push(...(await processW1MentionWatchForOrg(orgId)));
  }
  return results;
}
