/**
 * Immediate fulfillment when a human approves.
 * Audience-gated tools post Slack. sns.publish posts via the SNS adapter.
 * Notify-only side effects stay in resolve-side-effects.ts (never throws).
 */

import { appendAuditEvent } from "@/lib/data/audit";
import { updateApprovalMetadata } from "@/lib/data/approvals";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import {
  looksLikeSlackTs,
  postConversationMessage,
} from "@/lib/gateway/adapters/slack";
import {
  parseConversationContext,
  resolveConversationThreadId,
} from "@/lib/gateway/audience";
import {
  parseSnsSurface,
  publishSnsPost,
  type SnsPublishResult,
} from "@/lib/gateway/adapters/sns";
import { isAudienceGatedTool, isSnsPublishTool } from "@/lib/gateway/tools";
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
] as const;

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
    email?: string;
    phone?: string;
    lineId?: string;
  } | null;
  args: Record<string, unknown>;
  informationClass?: InformationClass;
  fidelity?: DisclosureFidelity;
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
};

export type ConversationDelivery =
  | { ok: true; delivery: "stub" }
  | { ok: true; delivery: "slack"; channel?: string; ts?: string }
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
    }
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
          email: str(convRaw.email),
          phone: str(convRaw.phone),
          lineId: str(convRaw.lineId),
        }
      : null,
    args,
    informationClass: str(rec.informationClass) as InformationClass | undefined,
    fidelity: str(rec.fidelity) as DisclosureFidelity | undefined,
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

function threadOf(snapshot: InvokeSnapshot): string | undefined {
  const resolved = resolveConversationThreadId({
    conversation: snapshot.conversation,
    args: snapshot.args,
  });
  return looksLikeSlackTs(resolved) ? resolved : undefined;
}

async function persistFulfillment(
  approval: ApprovalRequest,
  fulfillment: ApprovalFulfillment
): Promise<void> {
  const saved = await updateApprovalMetadata(approval, { fulfillment });
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
  const posted = await publishSnsPost({
    orgId: snapshot.orgId || approval.orgId,
    employeeId: snapshot.employeeId || approval.employeeId,
    surface: args.surface ?? args.snsSurface ?? args.media,
    text: outboundText(args, snapshot.purpose || approval.purpose),
    scheduledAt: args.scheduledAt ?? args.scheduled_at ?? args.scheduledFor,
    title: args.title,
  });
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
        error: posted.error,
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
 * After resolveApproval(approved): post the snapshotted Slack/etc. message.
 * Never throws — the human already said yes; failures are recorded on metadata.
 */
export async function fulfillApprovedInvoke(
  approval: ApprovalRequest
): Promise<ApprovalFulfillment | null> {
  try {
    const existing = parseFulfillment(approval.metadata);
    if (existing?.ok) return existing;

    if (approval.status !== "approved") return null;

    const snapshot = parseInvokeSnapshot(approval.metadata);
    if (!snapshot) return null;

    if (isSnsPublishTool(snapshot.tool || approval.tool || "")) {
      return fulfillSnsPublish(approval, snapshot);
    }

    if (!isAudienceGatedTool(snapshot.tool || approval.tool || "")) {
      return null;
    }

    const dest = destinationOf(snapshot);
    if (!dest) return null;

    const posted = await postConversationMessage({
      orgId: snapshot.orgId || approval.orgId,
      employeeId: snapshot.employeeId || approval.employeeId,
      postingAs: snapshot.postingAs,
      channel: dest,
      text: outboundText(snapshot.args, snapshot.purpose || approval.purpose),
      threadTs: threadOf(snapshot),
      // Human already approved the full mention-reply body.
      summarize: false,
    });

    const at = new Date().toISOString();
    const fulfillment: ApprovalFulfillment = posted.ok
      ? posted.delivery === "slack"
        ? {
            ok: true,
            delivery: "slack",
            channel: posted.channel,
            ts: posted.ts,
            at,
          }
        : { ok: true, delivery: "stub", at }
      : { ok: false, error: posted.error || "slack_post_failed", at };

    await persistFulfillment(approval, fulfillment);
    if (!posted.ok) {
      await auditFulfillmentFailure(
        approval,
        snapshot,
        posted.error || "slack_post_failed",
        dest
      ).catch(() => undefined);
    }
    return fulfillment;
  } catch (error) {
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
          error: message,
          phase: "approval.fulfill",
        },
      });
    } catch {
      /* audit is best-effort */
    }
    return fulfillment;
  }
}

export async function fulfillIfApproved(
  approval: ApprovalRequest,
  decision: "approved" | "rejected" | "revision_requested"
): Promise<ApprovalFulfillment | null> {
  if (decision !== "approved") return null;
  return fulfillApprovedInvoke(approval);
}
