import { isDemoMode } from "@/lib/mode";
import { isThreadSingleFlightEnabled } from "@/lib/feature-flags";
import { beginThreadSend, type ThreadSendHandle } from "@/lib/thread-guard/guard";
import { readThroughFromBody, readThroughFromSnapshot } from "@/lib/thread-guard/read-through";
import { auditThreadGuardStop } from "@/lib/thread-guard/respond";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { executeApproval } from "@/lib/approvals/execution";
import {
  attachmentAlreadyUploaded,
  liveFileUpload,
  parseStoredFileUpload,
  type FulfillmentFileUpload,
} from "@/lib/approvals/attachment-upload-claim";
import { readCardAttachment, sanitizeCardFilename } from "@/lib/approvals/attachment-card";
import {
  recheckGatewayToolAtFulfill,
  recheckAdminToolAtFulfill,
} from "@/lib/billing/plan-fulfill-recheck";
/**
 * Immediate fulfillment when a human approves.
 * Audience-gated tools post Slack. sns.publish posts via the SNS adapter.
 * Notify-only side effects stay in resolve-side-effects.ts (never throws).
 */

import { appendAuditEvent } from "@/lib/data/audit";
import {
  auditFulfillPolicyBlock,
  recheckPolicyAtFulfill,
  type FulfillPolicyRecheck,
} from "@/lib/approvals/fulfill-policy-recheck";
import { getApprovalById, updateApprovalMetadata } from "@/lib/data/approvals";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import {
  buildSnapshotAttachment,
  snapshotAttachmentState,
  type SnapshotAttachment,
} from "@/lib/approvals/snapshot-attachment";
import {
  looksLikeSlackTs,
  postConversationMessage,
  validateSlackPostDestination,
} from "@/lib/gateway/adapters/slack";
import {
  parseConversationContext,
  resolveConversationThreadId,
  resolveParentMessageTs,
} from "@/lib/gateway/audience";
import { lookupWakeParent, consumeWakeParent } from "@/lib/data/wake-parent-stash";
import {
  isSlackDmReplyInlineEnabled,
  isSlackDmReplyTarget,
  resolveSlackDmInlineThreadTs,
} from "@/lib/slack/dm-reply-inline";
import { getEffectiveReplyPolicy } from "@/lib/data/reply-policy";
import {
  parseSnsSurface,
  publishSnsPost,
  type SnsPublishResult,
} from "@/lib/gateway/adapters/sns";
import { isAudienceGatedTool, isSnsPublishTool, isConfirmClassTool, GATEWAY_TOOL_DEFS } from "@/lib/gateway/tools";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { stampW2WatchIfUnfulfilled } from "@/lib/stuck-watch/w2-unfulfilled";
import {
  DUPLICATE_POST_UNCERTAIN,
  FULFILL_BLOCKED_DEDUP_UNAVAILABLE,
  POST_OUTCOME_UNKNOWN,
  fulfillDedupFinish,
  fulfillDedupGate,
  ledgerOutcomeAfterPost,
  type FulfillDedupGate,
} from "@/lib/comm-reply-dedup/guard";
import { isConfigChangeApproval } from "@/lib/config-change-request/core";
import { fulfillConfigChangeApproval } from "@/lib/config-change-request/service";
import { buildSlackPostRecord } from "@/lib/comm-delete/post-record";
import { fulfillCommDeleteApproval } from "@/lib/comm-delete/fulfill";
import type {
  ApprovalRequest,
  ConversationContext,
  DisclosureFidelity,
  Employee,
  GatewayInvokeRequest,
  InformationClass,
  PostingAs,
} from "@/lib/types";

const SNAPSHOT_ARG_KEYS = [
  "text",
  "body",
  "message",
  "channel",
  "slackChannelId",
  "channelId",
  "channelName",
  "threadId",
  "thread_id",
  "thread_ts",
  "threadTs",
  "slackThreadTs",
  "messageTs",
  "slackTs",
  "ts",
  "to",
  "subject",
  "email",
  "recipient",
  "surface",
  "slackUserId",
  "userId",
  "phone",
  "lineId",
  "scheduledAt",
  "scheduled_at",
  "scheduledFor",
  "media",
  "snsSurface",
  // mail.send re-check at fulfill needs the same inputs the gateway judged.
  "cc",
  "bcc",
  "hasAttachments",
  "sealithTransferId",
  // comm.delete target (ids only).
  "messageId",
  "message_id",
  "chatId",
] as const;

/** Keys whose string[] value is kept in the snapshot (recipient lists). */
const LIST_ARG_KEYS = new Set<string>(["cc", "bcc"]);

const BODY_KEYS = new Set(["text", "body", "message"]);
const MAX_BODY_CHARS = 100_000;
const MAX_FIELD_CHARS = 8_192;

export type InvokeSnapshot = {
  tool: string;
  purpose: string;
  jobId: string;
  employeeId: string;
  orgId: string;
  postingAs: PostingAs;
  conversation: {
    surface?: ConversationContext["surface"];
    orgId?: string;
    slackChannelId?: string;
    slackUserId?: string;
    threadId?: string;
    ts?: string;
    email?: string;
    phone?: string;
    lineId?: string;
  } | null;
  args: Record<string, unknown>;
  informationClass?: InformationClass;
  fidelity?: DisclosureFidelity;
  /**
   * Conversation tools only: the approved attachment (sealed reference +
   * metadata), `null` = approved with no attachment, absent = legacy record.
   * See lib/approvals/snapshot-attachment.ts.
   */
  fileAttachment?: SnapshotAttachment | null;
  /**
   * Thread single-flight (THREAD_SINGLE_FLIGHT_ENABLED): the explicit read
   * point sent with the request (normalized Slack-style ts). Fulfil checks
   * against this (else conversation.ts), never against a re-run request's.
   */
  readThroughTs?: string;
};

export type ApprovalFulfillment = {
  ok: boolean;
  delivery?: "stub" | "slack" | "mail" | "sns";
  channel?: string;
  ts?: string;
  id?: string;
  surface?: string;
  error?: string;
  at: string;
  threadTsSource?: "client" | "wake_stash";
  /**
   * Approved attachment (conversation tools). Paths that post the approved text
   * only (approval callback, W2) record `not_sent` / `rerun_required`; the live
   * upload state (sent / in_progress / uncertain / failed) is derived from
   * metadata.attachmentUpload by parseFulfillment.
   */
  fileUpload?: FulfillmentFileUpload;
  /** comm.delete outcome (ids / status only). */
  commDelete?: { status: string; code: string; deletedVia?: "user" | "bot" };
  /**
   * Duplicate post guard v2: error "post_outcome_unknown" — the ledger row id
   * kept as uncertain (verify the post, then resend with confirmedNotDelivered).
   */
  uncertainRef?: string;
  /**
   * Thread single-flight stop at fulfil (error thread_busy / thread_moved_on /
   * thread_guard_unavailable): retryAfterSeconds or readThroughTs + selfPostedTs.
   */
  threadGuard?: Record<string, unknown>;
};

export type ConversationDelivery =
  | { ok: true; delivery: "stub" }
  | { ok: true; delivery: "slack"; channel?: string; ts?: string; postedVia?: PostingAs }
  | { ok: true; delivery: "mail"; channel?: string; ts?: string };

function jsonClone<T>(value: T): T | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return undefined;
  }
}

function clipString(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function pickSnapshotArgs(args: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of SNAPSHOT_ARG_KEYS) {
    if (!(key in args)) continue;
    const value = args[key];
    if (typeof value === "string") {
      picked[key] = clipString(
        value,
        BODY_KEYS.has(key) ? MAX_BODY_CHARS : MAX_FIELD_CHARS
      );
      continue;
    }
    if (
      value == null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      picked[key] = value;
      continue;
    }
    if (
      LIST_ARG_KEYS.has(key) &&
      Array.isArray(value) &&
      value.every((v) => typeof v === "string")
    ) {
      picked[key] = (value as string[]).map((v) => clipString(v, MAX_FIELD_CHARS));
    }
  }
  // Attachments themselves are never snapshotted; keep the fact that there were some.
  if (Array.isArray(args.attachments) && args.attachments.length > 0) {
    picked.hasAttachments = true;
  }
  return jsonClone(picked) ?? picked;
}

function snapshotConversation(
  conversation: ConversationContext | null
): InvokeSnapshot["conversation"] {
  if (!conversation) return null;
  const cloned = jsonClone({
    surface: conversation.surface,
    orgId: conversation.orgId,
    slackChannelId: conversation.slackChannelId,
    slackUserId: conversation.slackUserId,
    threadId: conversation.threadId,
    ts: conversation.ts,
    email: conversation.email,
    phone: conversation.phone,
    lineId: conversation.lineId,
  });
  return cloned ?? null;
}

export function buildInvokeSnapshot(input: {
  tool: string;
  purpose: string;
  jobId: string;
  employeeId: string;
  orgId: string;
  employee?: Employee | null;
  body?: GatewayInvokeRequest;
  conversation?: ConversationContext | null;
  informationClass?: InformationClass | null;
  fidelity?: DisclosureFidelity | null;
}): InvokeSnapshot {
  const args =
    input.body?.args && typeof input.body.args === "object"
      ? (input.body.args as Record<string, unknown>)
      : {};
  const parsed =
    input.conversation ??
    (input.body ? parseConversationContext(input.body, input.orgId) : null);
  const resolvedThread = resolveConversationThreadId({
    conversation: parsed,
    args,
    body: input.body,
  });
  const conversation =
    parsed && resolvedThread && parsed.threadId !== resolvedThread
      ? { ...parsed, threadId: resolvedThread }
      : parsed;
  const snapshot: InvokeSnapshot = {
    tool: input.tool,
    purpose: input.purpose,
    jobId: input.jobId,
    employeeId: input.employeeId,
    orgId: input.orgId,
    postingAs: normalizePostingAs(input.employee?.postingAs),
    conversation: snapshotConversation(conversation),
    args: pickSnapshotArgs(args),
  };
  const informationClass =
    input.informationClass || input.body?.informationClass || undefined;
  const fidelity = input.fidelity || input.body?.disclosure || undefined;
  if (informationClass) snapshot.informationClass = informationClass;
  if (fidelity) snapshot.fidelity = fidelity;
  if (isThreadSingleFlightEnabled() && isAudienceGatedTool(input.tool) && input.body) {
    const readThrough = readThroughFromBody(input.body as unknown as Record<string, unknown>);
    if (readThrough?.source === "explicit") snapshot.readThroughTs = readThrough.ts;
  }
  // Always recorded for conversation tools so "no attachment" is explicit (null).
  if (isAudienceGatedTool(input.tool)) {
    snapshot.fileAttachment = buildSnapshotAttachment(input.body?.fileAttachment);
  }
  return jsonClone(snapshot) ?? snapshot;
}

export function parseInvokeSnapshot(
  metadata: Record<string, unknown> | undefined | null
): InvokeSnapshot | null {
  const raw = metadata?.invoke;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.tool !== "string" || !rec.tool.trim()) return null;
  const args =
    rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)
      ? (rec.args as Record<string, unknown>)
      : {};
  const convRaw =
    rec.conversation &&
    typeof rec.conversation === "object" &&
    !Array.isArray(rec.conversation)
      ? (rec.conversation as Record<string, unknown>)
      : null;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    tool: rec.tool,
    purpose: typeof rec.purpose === "string" ? rec.purpose : "",
    jobId: typeof rec.jobId === "string" ? rec.jobId : "",
    employeeId: typeof rec.employeeId === "string" ? rec.employeeId : "",
    orgId: typeof rec.orgId === "string" ? rec.orgId : "",
    postingAs: normalizePostingAs(rec.postingAs),
    conversation: convRaw
      ? {
          surface: str(convRaw.surface) as ConversationContext["surface"] | undefined,
          orgId: str(convRaw.orgId),
          slackChannelId: str(convRaw.slackChannelId),
          slackUserId: str(convRaw.slackUserId),
          threadId: str(convRaw.threadId),
          ts: str(convRaw.ts),
          email: str(convRaw.email),
          phone: str(convRaw.phone),
          lineId: str(convRaw.lineId),
        }
      : null,
    args,
    informationClass: str(rec.informationClass) as InformationClass | undefined,
    fidelity: str(rec.fidelity) as DisclosureFidelity | undefined,
    ...(str(rec.readThroughTs) ? { readThroughTs: str(rec.readThroughTs) } : {}),
  };
}

export function parseFulfillment(
  metadata: Record<string, unknown> | undefined | null
): ApprovalFulfillment | null {
  const raw = metadata?.fulfillment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ok !== "boolean") return null;
  const delivery =
    rec.delivery === "slack" ||
    rec.delivery === "stub" ||
    rec.delivery === "mail" ||
    rec.delivery === "sns"
      ? rec.delivery
      : undefined;
  const fulfillment: ApprovalFulfillment = {
    ok: rec.ok,
    at: typeof rec.at === "string" ? rec.at : new Date().toISOString(),
  };
  if (delivery) fulfillment.delivery = delivery;
  if (typeof rec.channel === "string") fulfillment.channel = rec.channel;
  if (typeof rec.ts === "string") fulfillment.ts = rec.ts;
  if (typeof rec.id === "string") fulfillment.id = rec.id;
  if (typeof rec.surface === "string") fulfillment.surface = rec.surface;
  if (typeof rec.error === "string") fulfillment.error = rec.error;
  if (rec.threadGuard && typeof rec.threadGuard === "object" && !Array.isArray(rec.threadGuard)) {
    fulfillment.threadGuard = { ...(rec.threadGuard as Record<string, unknown>) };
  }
  if (rec.threadTsSource === "client" || rec.threadTsSource === "wake_stash") {
    fulfillment.threadTsSource = rec.threadTsSource;
  }
  const fileUpload = liveFileUpload(metadata, parseStoredFileUpload(rec.fileUpload));
  if (fileUpload) fulfillment.fileUpload = fileUpload;
  const cd = rec.commDelete;
  if (cd && typeof cd === "object" && !Array.isArray(cd)) {
    const c = cd as Record<string, unknown>;
    if (typeof c.status === "string" && typeof c.code === "string") {
      fulfillment.commDelete = {
        status: c.status,
        code: c.code,
        ...(c.deletedVia === "user" || c.deletedVia === "bot" ? { deletedVia: c.deletedVia } : {}),
      };
    }
  }
  return fulfillment;
}

/** Skip re-post when human approval already delivered to Slack / mail / etc. */
export function conversationDeliveryFromFulfillment(
  approval: ApprovalRequest | null | undefined
): ConversationDelivery | null {
  const fulfillment = parseFulfillment(approval?.metadata);
  if (!fulfillment?.ok) return null;
  if (fulfillment.delivery === "slack") {
    return {
      ok: true,
      delivery: "slack",
      ...(fulfillment.channel ? { channel: fulfillment.channel } : {}),
      ...(fulfillment.ts ? { ts: fulfillment.ts } : {}),
    };
  }
  if (fulfillment.delivery === "mail") {
    return {
      ok: true,
      delivery: "mail",
      ...(fulfillment.channel ? { channel: fulfillment.channel } : {}),
      ...(fulfillment.ts ? { ts: fulfillment.ts } : {}),
    };
  }
  return null;
}

export function snsDeliveryFromFulfillment(
  approval: ApprovalRequest | null | undefined
): SnsPublishResult | null {
  const fulfillment = parseFulfillment(approval?.metadata);
  if (!fulfillment) return null;
  if (fulfillment.ok && (fulfillment.delivery === "sns" || fulfillment.delivery === "stub")) {
    const surface = parseSnsSurface(fulfillment.surface) || "x";
    return {
      ok: true,
      delivery: fulfillment.delivery === "stub" ? "stub" : "sns",
      surface,
      ...(fulfillment.id ? { id: fulfillment.id } : {}),
    };
  }
  if (!fulfillment.ok && fulfillment.error) {
    return {
      ok: false,
      error: fulfillment.error,
      surface: parseSnsSurface(fulfillment.surface) || undefined,
    };
  }
  return null;
}

/**
 * The text a conversation approval posts when fulfilled. Also used to compare
 * a pending approval with a newer reply (COMM_REPLY_DEDUP_ENABLED supersede):
 * the body itself is never stored by the dedup code, only fingerprinted.
 */
export function invokeSnapshotOutboundText(snapshot: InvokeSnapshot, fallbackPurpose: string): string {
  return outboundText(snapshot.args ?? {}, snapshot.purpose || fallbackPurpose);
}

function outboundText(args: Record<string, unknown>, fallback: string): string {
  const raw = [args.text, args.body, args.message].find(
    (value) => typeof value === "string" && value.trim()
  );
  return (typeof raw === "string" ? raw : "").trim() || fallback;
}

function destinationOf(snapshot: InvokeSnapshot): string {
  const conv = snapshot.conversation;
  const args = snapshot.args;
  const fromConv = conv?.slackChannelId || conv?.slackUserId || "";
  if (fromConv) return fromConv;
  const fromArgs = [args.slackChannelId, args.channel, args.channelId, args.slackUserId].find(
    (value) => typeof value === "string" && value.trim()
  );
  return typeof fromArgs === "string" ? fromArgs.trim() : "";
}

/**
 * Resolve thread_ts for fulfill-time posting. Mirrors invoke.ts logic:
 * 1. Explicit thread_ts from snapshot (resolveConversationThreadId)
 * 2. If prefer_thread policy and no explicit thread_ts:
 *    a) Try client-provided parent ts (resolveParentMessageTs)
 *    b) Fall back to wake parent stash (lookupWakeParent)
 *
 * Note: Wake parent stash is in-memory and may not survive across restarts.
 * For durable prefer_thread, agents should pass thread_ts=wake.ts on invoke.
 */
async function threadOf(
  snapshot: InvokeSnapshot,
  dest?: string
): Promise<{ threadTs: string | undefined; source: "client" | "wake_stash" | "none" }> {
  const conv = snapshot.conversation;
  const args = snapshot.args;

  // G4 (SLACK_DM_REPLY_INLINE_ENABLED): same DM rule as invoke — main flow,
  // unless the message is already inside a thread (thread_ts ≠ ts).
  if (
    conv?.surface === "slack" &&
    isSlackDmReplyInlineEnabled() &&
    isSlackDmReplyTarget({ channelId: dest || conv.slackChannelId, conversation: conv, args })
  ) {
    return resolveSlackDmInlineThreadTs({ conversation: conv, args });
  }

  const explicitThreadTs = resolveConversationThreadId({
    conversation: conv,
    args,
  });

  if (looksLikeSlackTs(explicitThreadTs)) {
    return { threadTs: explicitThreadTs, source: "client" };
  }

  if (conv?.surface !== "slack" || !conv.slackChannelId) {
    return { threadTs: undefined, source: "none" };
  }

  const replyPolicyResult = await getEffectiveReplyPolicy(
    snapshot.orgId || conv.orgId,
    snapshot.employeeId
  );
  const threadAffinity = replyPolicyResult.policy.rules?.[0]?.threadAffinity;

  if (threadAffinity !== "prefer_thread") {
    return { threadTs: undefined, source: "none" };
  }

  const parentTs = resolveParentMessageTs({ conversation: conv, args });
  if (looksLikeSlackTs(parentTs)) {
    return { threadTs: parentTs, source: "client" };
  }

  const wakeParent = lookupWakeParent({
    orgId: snapshot.orgId || conv.orgId || "",
    employeeId: snapshot.employeeId,
    channelId: conv.slackChannelId,
  });
  if (wakeParent && looksLikeSlackTs(wakeParent.parentTs)) {
    consumeWakeParent({
      orgId: snapshot.orgId || conv.orgId || "",
      employeeId: snapshot.employeeId,
      channelId: conv.slackChannelId,
    });
    return { threadTs: wakeParent.parentTs, source: "wake_stash" };
  }

  return { threadTs: undefined, source: "none" };
}

async function persistFulfillment(
  approval: ApprovalRequest,
  fulfillment: ApprovalFulfillment
): Promise<void> {
  const saved = await updateApprovalMetadata(approval, { fulfillment });
  if (!saved && !isDemoMode()) throw new Error("approval_metadata_save_failed");
  approval.metadata = saved
    ? saved.metadata
    : { ...approval.metadata, fulfillment };
}

async function auditFulfillmentFailure(
  approval: ApprovalRequest,
  snapshot: InvokeSnapshot,
  error: string,
  dest: string,
  action: "slack.post_failed" | "sns.publish_failed" = "slack.post_failed"
): Promise<void> {
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    action,
    purpose: approval.purpose,
    summary:
      action === "sns.publish_failed"
        ? "承認直後のSNS投稿に失敗"
        : "承認直後の会話投稿に失敗",
    metadata: {
      approvalId: approval.id,
      tool: snapshot.tool,
      jobId: snapshot.jobId,
      error,
      dest,
      phase: "approval.fulfill",
    },
  });
}

async function fulfillSnsPublish(
  approval: ApprovalRequest,
  snapshot: InvokeSnapshot
): Promise<ApprovalFulfillment> {
  const args = snapshot.args;
  const text = outboundText(args, snapshot.purpose || approval.purpose);
  // Duplicate post guard v2 (DUPLICATE_GUARD_V2_ENABLED; OFF → no-op): the same
  // ledger as conversation posts — same / similar post after this approval was
  // created or within the window, same jobId, or an unknown-outcome post.
  const gate = await fulfillDedupGate(approval, snapshot, text);
  if (!gate.ok) {
    const blocked: ApprovalFulfillment = { ok: false, error: gate.code, at: new Date().toISOString() };
    if (gate.code === FULFILL_BLOCKED_DEDUP_UNAVAILABLE || gate.code === DUPLICATE_POST_UNCERTAIN) {
      await persistFulfillment(approval, blocked);
    }
    return blocked;
  }
  let posted: SnsPublishResult;
  try {
    posted = await publishSnsPost({
      orgId: snapshot.orgId || approval.orgId,
      employeeId: snapshot.employeeId || approval.employeeId,
      surface: args.surface ?? args.snsSurface ?? args.media,
      text,
      scheduledAt: args.scheduledAt ?? args.scheduled_at ?? args.scheduledFor,
      title: args.title,
    });
  } catch (error) {
    await fulfillDedupFinish(gate, approval, "uncertain").catch(() => undefined);
    throw error;
  }
  const outcome = ledgerOutcomeAfterPost(gate.prepared, posted);
  await fulfillDedupFinish(gate, approval, outcome).catch(() => undefined);
  const unknown = !posted.ok && outcome === "uncertain" && gate.prepared.kind === "ready";
  const at = new Date().toISOString();
  const fulfillment: ApprovalFulfillment = posted.ok
    ? {
        ok: true,
        delivery: posted.delivery,
        surface: posted.surface,
        ...(posted.id ? { id: posted.id, ts: posted.id } : {}),
        at,
      }
    : {
        ok: false,
        error: unknown ? POST_OUTCOME_UNKNOWN : posted.error,
        ...(unknown && gate.claimId ? { uncertainRef: gate.claimId } : {}),
        ...(posted.surface ? { surface: posted.surface } : {}),
        at,
      };
  await persistFulfillment(approval, fulfillment);
  if (!posted.ok) {
    await auditFulfillmentFailure(
      approval,
      snapshot,
      posted.error,
      posted.surface || "sns",
      "sns.publish_failed"
    ).catch(() => undefined);
  }
  return fulfillment;
}

/**
 * mail.send fulfill-on-approve: honest stub fulfillment with audit.
 * Live mail send is not yet implemented — record stub, never pretend real send.
 */
async function fulfillMailSend(
  approval: ApprovalRequest,
  snapshot: InvokeSnapshot
): Promise<ApprovalFulfillment> {
  const at = new Date().toISOString();
  const args = snapshot.args;

  const to = (
    typeof args.to === "string" ? args.to :
    typeof args.recipient === "string" ? args.recipient :
    typeof args.email === "string" ? args.email :
    snapshot.conversation?.email ?? ""
  );

  const subject = (
    typeof args.subject === "string" ? args.subject :
    typeof args.title === "string" ? args.title :
    ""
  );

  // Record honest stub fulfillment — live mail send is not implemented
  const fulfillment: ApprovalFulfillment = {
    ok: true,
    delivery: "stub",
    at,
  };

  await persistFulfillment(approval, fulfillment);

  const artifact = approval.metadata?.artifact as Record<string, unknown> | undefined;
  const sendMode =
    typeof artifact?.sendMode === "string"
      ? artifact.sendMode
      : typeof approval.metadata?.mailPolicy === "object" &&
          approval.metadata?.mailPolicy &&
          typeof (approval.metadata.mailPolicy as Record<string, unknown>).sendMode === "string"
        ? String((approval.metadata.mailPolicy as Record<string, unknown>).sendMode)
        : undefined;

  // Audit: record the approved mail.send with stub fulfillment
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    action: "tool.invoke",
    purpose: approval.purpose,
    summary: "承認済みメール送信（スタブ実行・ライブ送信は未実装）",
    metadata: {
      approvalId: approval.id,
      tool: snapshot.tool,
      jobId: snapshot.jobId,
      delivery: "stub",
      to,
      subject,
      sendMode,
      phase: "approval.fulfill",
      noteJa: "mail.send のライブ送信は未実装。承認後の記録のみ。",
    },
  }).catch(() => undefined);

  return fulfillment;
}

/** Record a fulfill-time policy stop: persisted on the approval + audited. */
async function blockFulfillment(
  approval: ApprovalRequest,
  snapshot: InvokeSnapshot,
  block: Extract<FulfillPolicyRecheck, { ok: false }>
): Promise<ApprovalFulfillment> {
  const fulfillment: ApprovalFulfillment = {
    ok: false,
    error: block.code,
    at: new Date().toISOString(),
  };
  try {
    await persistFulfillment(approval, fulfillment);
  } catch {
    approval.metadata = { ...approval.metadata, fulfillment };
  }
  await auditFulfillPolicyBlock(approval, snapshot, block).catch(() => undefined);
  return fulfillment;
}

function isMailSendTool(tool: string): boolean {
  return tool === "mail.send";
}

/**
 * Only the approved text is posted here. When the snapshot carries an approved
 * attachment that is not uploaded yet, say so (result + audit) instead of
 * staying silent; the agent re-run with the approvalId uploads it.
 */
function attachmentNotSent(approval: ApprovalRequest): FulfillmentFileUpload | undefined {
  const state = snapshotAttachmentState(approval.metadata?.invoke);
  if (state.kind !== "present" || attachmentAlreadyUploaded(approval.metadata)) return undefined;
  const card = readCardAttachment(approval.metadata);
  const filename = card?.kind === "present" ? card.filename : sanitizeCardFilename(state.attachment.filename);
  return {
    status: "not_sent",
    reason: "rerun_required",
    filename,
    ...(state.attachment.bytes !== undefined ? { bytes: state.attachment.bytes } : {}),
  };
}

async function auditAttachmentNotSent(
  approval: ApprovalRequest,
  snapshot: InvokeSnapshot,
  fileUpload: FulfillmentFileUpload
): Promise<void> {
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    action: "approval.attachment_not_sent",
    purpose: approval.purpose,
    summary: "承認済みの本文のみ投稿し、承認された添付は未送信（エージェントの approvalId 付き再実行で送信）",
    metadata: {
      approvalId: approval.id,
      tool: snapshot.tool,
      jobId: snapshot.jobId,
      reason: "rerun_required",
      // filename / bytes only: never the reference, its host or its hash.
      filename: "filename" in fileUpload ? fileUpload.filename : undefined,
      bytes: "bytes" in fileUpload ? fileUpload.bytes : undefined,
      phase: "approval.fulfill",
    },
  });
}

type FulfillInvokeOptions = {
  /** The caller uploads the approved attachment itself (agent re-run). */
  attachmentHandledByCaller?: boolean;
};

/**
 * After resolveApproval(approved): post the snapshotted Slack/etc. message.
 * Never throws — the human already said yes; failures are recorded on metadata.
 */
async function fulfillApprovedInvokeCore(
  approval: ApprovalRequest,
  options: FulfillInvokeOptions = {}
): Promise<ApprovalFulfillment | null> {
  let dedupGate: FulfillDedupGate | null = null;
  let postAttempted = false;
  // Thread single-flight lease (released in `finally` on every path).
  let threadHandle: ThreadSendHandle | null = null;
  let threadSent: { sent: boolean; messageTs?: string } = { sent: false };
  try {
    const existing = parseFulfillment(approval.metadata);
    if (existing?.ok) return existing;

    if (approval.status !== "approved") return null;

    const snapshot = parseInvokeSnapshot(approval.metadata);
    if (!snapshot) return null;

    // Inside the execution claim: settings may have changed since the
    // pre-claim check (TOCTOU). Stop before any provider call.
    const recheck = await recheckPolicyAtFulfill(approval, snapshot);
    if (!recheck.ok) return blockFulfillment(approval, snapshot, recheck);

    if (isSnsPublishTool(snapshot.tool || approval.tool || "")) {
      return fulfillSnsPublish(approval, snapshot);
    }

    // comm.delete: re-check flag / ownership / idempotency at execution time.
    if ((snapshot.tool || approval.tool) === "comm.delete") {
      const fulfillment = await fulfillCommDeleteApproval(approval, snapshot.args ?? {});
      await persistFulfillment(approval, fulfillment);
      return fulfillment;
    }

    // mail.send: honest stub fulfillment (live send not yet implemented)
    if (isMailSendTool(snapshot.tool || approval.tool || "")) {
      return fulfillMailSend(approval, snapshot);
    }

    if (!isAudienceGatedTool(snapshot.tool || approval.tool || "")) {
      return null;
    }

    const snapshotArgs = snapshot.args ?? {};
    const dmIntent =
      snapshotArgs.dm === true ||
      snapshotArgs.postingTo === "im" ||
      snapshotArgs.dmIntent === true;
    const destValidation = validateSlackPostDestination({
      slackChannelId: snapshot.conversation?.slackChannelId,
      slackUserId: snapshot.conversation?.slackUserId,
      dmIntent,
    });

    if (!destValidation.ok) {
      const at = new Date().toISOString();
      const fulfillment: ApprovalFulfillment = {
        ok: false,
        error: destValidation.code,
        at,
      };
      await persistFulfillment(approval, fulfillment);
      await appendAuditEvent({
        orgId: approval.orgId,
        employeeId: approval.employeeId,
        credentialId: approval.credentialId,
        action: "slack.post_failed",
        purpose: approval.purpose,
        summary: "承認直後の会話投稿をユーザーID宛てDM禁止で拒否（fail-closed）",
        metadata: {
          approvalId: approval.id,
          tool: snapshot.tool,
          jobId: snapshot.jobId,
          code: destValidation.code,
          slackChannelId: snapshot.conversation?.slackChannelId,
          slackUserId: snapshot.conversation?.slackUserId,
          dmIntent,
          phase: "approval.fulfill",
        },
      }).catch(() => undefined);
      return fulfillment;
    }

    const dest = destValidation.dest;

    // THREAD_SINGLE_FLIGHT_ENABLED: the same lease + "already moved on" check
    // as a direct post, against the APPROVED snapshot's read point. Before the
    // ledger claim, so a stop leaves nothing behind. Stops keep the approval
    // approved (re-runnable once the thread is free / re-read).
    let earlyThread: Awaited<ReturnType<typeof threadOf>> | null = null;
    if (isThreadSingleFlightEnabled()) {
      earlyThread = await threadOf(snapshot, dest);
      const threadSend = await beginThreadSend({
        orgId: snapshot.orgId || approval.orgId,
        employeeId: snapshot.employeeId || approval.employeeId,
        jobId: snapshot.jobId || approval.jobId,
        keyInput: {
          orgId: snapshot.orgId || approval.orgId,
          surface: "slack",
          slackChannelId: dest,
          threadId: earlyThread.threadTs,
        },
        readThrough: readThroughFromSnapshot(snapshot),
      });
      if (threadSend.kind === "stop") {
        const guardExtra = Object.fromEntries(
          ["retryAfterSeconds", "readThroughTs", "selfPostedTs"]
            .filter((k) => threadSend.body[k] !== undefined)
            .map((k) => [k, threadSend.body[k]])
        );
        const blocked: ApprovalFulfillment = {
          ok: false,
          error: threadSend.code,
          threadGuard: guardExtra,
          at: new Date().toISOString(),
        };
        await persistFulfillment(approval, blocked);
        await auditThreadGuardStop(threadSend, {
          orgId: approval.orgId,
          employeeId: approval.employeeId,
          credentialId: approval.credentialId,
          purpose: approval.purpose,
          tool: snapshot.tool,
          jobId: snapshot.jobId,
          approvalId: approval.id,
          phase: "fulfil",
        });
        return blocked;
      }
      if (threadSend.kind === "held") threadHandle = threadSend.handle;
    }

    // COMM_REPLY_DEDUP_ENABLED: expired, or the conversation already got a reply
    // with the same / a similar body after this approval was created → closed
    // without sending. Claims the send in the hash-only ledger otherwise. Fail
    // closed when the ledger is down. Taken only after every check that can
    // refuse the send without throwing (destination validation above), so a
    // refused send never leaves a claim behind (木村 review on #260): from
    // here on every path finishes the claim — sent / failed after the post,
    // failed on a throw before the post, uncertain on a throw from the post.
    dedupGate = await fulfillDedupGate(approval, snapshot, invokeSnapshotOutboundText(snapshot, approval.purpose));
    if (!dedupGate.ok) {
      const blocked: ApprovalFulfillment = { ok: false, error: dedupGate.code, at: new Date().toISOString() };
      // Stopped before any provider call, approval kept approved (re-runnable):
      // record why. Superseded / expired are recorded by the close itself.
      if (dedupGate.code === FULFILL_BLOCKED_DEDUP_UNAVAILABLE || dedupGate.code === DUPLICATE_POST_UNCERTAIN) {
        await persistFulfillment(approval, blocked);
      }
      return blocked;
    }

    const threadResult = earlyThread ?? (await threadOf(snapshot, dest));

    postAttempted = true;

    const posted = await postConversationMessage({
      orgId: snapshot.orgId || approval.orgId,
      employeeId: snapshot.employeeId || approval.employeeId,
      postingAs: snapshot.postingAs,
      channel: dest,
      text: outboundText(snapshot.args, snapshot.purpose || approval.purpose),
      threadTs: threadResult.threadTs,
      // Human already approved the full mention-reply body.
      summarize: false,
    });
    if (posted.ok && posted.delivery === "slack") threadSent = { sent: true, messageTs: posted.ts };
    const gateAfterPost = dedupGate;
    dedupGate = null;
    // v1: failed releases the claim. v2: only a provider-confirmed "not sent"
    // releases it; an unknown outcome (timeout / 5xx after submit) is kept as
    // uncertain so neither a re-run nor a direct resend goes out blindly.
    const ledgerOutcome = gateAfterPost.ok ? ledgerOutcomeAfterPost(gateAfterPost.prepared, posted) : posted.ok ? "sent" : "failed";
    await fulfillDedupFinish(gateAfterPost, approval, ledgerOutcome).catch(() => undefined);
    const outcomeUnknown =
      !posted.ok && ledgerOutcome === "uncertain" && gateAfterPost.ok && gateAfterPost.prepared.kind === "ready";

    const at = new Date().toISOString();
    const notSent = posted.ok && !options.attachmentHandledByCaller ? attachmentNotSent(approval) : undefined;
    const fulfillment: ApprovalFulfillment = posted.ok
      ? posted.delivery === "slack"
        ? {
            ok: true,
            delivery: "slack",
            channel: posted.channel,
            ts: posted.ts,
            at,
            ...(notSent ? { fileUpload: notSent } : {}),
          }
        : { ok: true, delivery: "stub", at, ...(notSent ? { fileUpload: notSent } : {}) }
      : outcomeUnknown
        ? {
            ok: false,
            error: POST_OUTCOME_UNKNOWN,
            ...(gateAfterPost.ok && gateAfterPost.claimId ? { uncertainRef: gateAfterPost.claimId } : {}),
            at,
          }
        : { ok: false, error: posted.error || "slack_post_failed", at };

    await persistFulfillment(approval, {
      ...fulfillment,
      threadTsSource: threadResult.source !== "none" ? threadResult.source : undefined,
    } as ApprovalFulfillment);
    if (notSent) await auditAttachmentNotSent(approval, snapshot, notSent).catch(() => undefined);
    if (!posted.ok) {
      await auditFulfillmentFailure(
        approval,
        snapshot,
        posted.error || "slack_post_failed",
        dest
      ).catch(() => undefined);
    } else if (posted.delivery === "slack") {
      const destKind: "dm" | "channel_thread" | "channel" =
        dest.startsWith("D") ? "dm" :
        threadResult.threadTs ? "channel_thread" : "channel";
      await appendAuditEvent({
        orgId: approval.orgId,
        employeeId: approval.employeeId,
        credentialId: approval.credentialId,
        action: "slack.posted",
        purpose: approval.purpose,
        summary: "承認済み会話投稿を実行",
        metadata: {
          tool: snapshot.tool,
          jobId: snapshot.jobId,
          approvalId: approval.id,
          channel: posted.channel,
          thread_ts: threadResult.threadTs,
          ts: posted.ts,
          destKind,
          phase: "approval.fulfill",
          ...(() => {
            const postRecord = buildSlackPostRecord(posted);
            return postRecord ? { postRecord } : {};
          })(),
        },
      }).catch(() => undefined);
    }
    return fulfillment;
  } catch (error) {
    // Ledger claim still open: a throw from the post itself = unknown outcome →
    // kept as uncertain (never re-sent blindly); a throw before the post (thread
    // / reply-policy lookup) sent nothing → released.
    if (dedupGate) {
      await fulfillDedupFinish(dedupGate, approval, postAttempted ? "uncertain" : "failed").catch(() => undefined);
    }
    const at = new Date().toISOString();
    const message = error instanceof Error ? error.message : "fulfill_failed";
    const fulfillment: ApprovalFulfillment = { ok: false, error: message, at };
    try {
      await persistFulfillment(approval, fulfillment);
    } catch {
      approval.metadata = { ...approval.metadata, fulfillment };
    }
    try {
      await appendAuditEvent({
        orgId: approval.orgId,
        employeeId: approval.employeeId,
        credentialId: approval.credentialId,
        action: "slack.post_failed",
        purpose: approval.purpose,
        summary: "承認直後の会話投稿に失敗",
        metadata: {
          approvalId: approval.id,
          tool: approval.tool,
          jobId: approval.jobId,
          error: message,
          phase: "approval.fulfill",
        },
      });
    } catch {
      /* audit is best-effort */
    }
    return fulfillment;
  } finally {
    if (threadHandle) await threadHandle.finish(threadSent).catch(() => undefined);
  }
}

export async function fulfillIfApproved(
  approval: ApprovalRequest,
  decision: "approved" | "rejected" | "revision_requested"
): Promise<ApprovalFulfillment | null> {
  if (decision !== "approved") return null;

  // config.change_request: configuration, not a plan-gated gateway capability.
  if (isConfigChangeApproval(approval)) {
    const result = await fulfillConfigChangeApproval(approval);
    if (result && !result.ok) await stampW2WatchIfUnfulfilled(approval);
    return result;
  }

  const tool = approval.tool || "";
  const isAdminTool = isAdminClassApproval(approval);

  // P1 Plan Rails: Re-check plan scope at fulfill time
  if (isAdminTool) {
    const planCheck = await recheckAdminToolAtFulfill(approval.orgId, tool, approval);
    if (!planCheck.ok) {
      const result: ApprovalFulfillment = {
        ok: false,
        delivery: "stub",
        at: new Date().toISOString(),
        error: `plan_recheck_failed: ${planCheck.code}`,
      };
      await stampW2WatchIfUnfulfilled(approval);
      return result;
    }
  } else if (tool) {
    const planCheck = await recheckGatewayToolAtFulfill(approval.orgId, tool, approval);
    if (!planCheck.ok) {
      const result: ApprovalFulfillment = {
        ok: false,
        delivery: "stub",
        at: new Date().toISOString(),
        error: `plan_recheck_failed: ${planCheck.code}`,
      };
      await stampW2WatchIfUnfulfilled(approval);
      return result;
    }
  }

  const admin = await fulfillApprovedAdmin(approval);
  if (admin) {
    const result: ApprovalFulfillment = {
      ok: admin.ok,
      delivery: "stub",
      at: admin.at,
      error: admin.error,
    };
    if (!admin.ok) {
      await stampW2WatchIfUnfulfilled(approval);
    }
    return result;
  }
  const invoke = await fulfillApprovedInvoke(approval);
  if (!invoke?.ok) {
    await stampW2WatchIfUnfulfilled(approval);
  }
  return invoke;
}

export async function fulfillApprovedInvoke(
  approval: ApprovalRequest,
  options: FulfillInvokeOptions = {}
): Promise<ApprovalFulfillment | null> {
  if (approval.status === "approved" && isConfigChangeApproval(approval)) {
    return fulfillConfigChangeApproval(approval);
  }
  const snapshot = approval.status === "approved" ? parseInvokeSnapshot(approval.metadata) : null;
  if (approval.status !== "approved" || !snapshot || isAdminClassApproval(approval)) return null;
  // Re-check tool settings / mail policy before taking the execution claim so
  // a stop is audited with its reason (the authority check would otherwise
  // throw a generic approval_authority_revoked) and the claim is not touched.
  if (!parseFulfillment(approval.metadata)?.ok) {
    try {
      const recheck = await recheckPolicyAtFulfill(approval, snapshot);
      if (!recheck.ok) {
        // The caller's copy may be stale: never overwrite a fulfillment that
        // already succeeded elsewhere (the send happened; report that instead).
        const fresh = await getApprovalById(approval.id, approval.orgId).catch(() => null);
        const done = fresh ? parseFulfillment(fresh.metadata) : null;
        if (done?.ok) return done;
        return await blockFulfillment(approval, snapshot, recheck);
      }
    } catch (error) {
      return { ok: false, at: new Date().toISOString(),
        error: error instanceof Error ? error.message : "fulfill_recheck_failed" };
    }
  }
  try { return await executeApproval(approval, () => fulfillApprovedInvokeCore(approval, options)); }
  catch (error) {
    return { ok: false, at: new Date().toISOString(),
      error: error instanceof Error ? error.message : "approval_execution_failed" };
  }
}
