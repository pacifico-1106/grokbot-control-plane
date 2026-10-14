/**
 * "Nothing was sent" — one wording for the AI and the approver.
 *
 * H1 (LINE / LINE WORKS design 10/12 §6): the gateway posts conversation
 * messages to Slack only. A comm.reply / comm.send / slack.post to any other
 * destination (LINE, mail, phone, …) cannot be sent, so it must never come back
 * as ok / accepted, and an approved one that stops at fulfil
 * (slack_channel_required) must not look "fulfilled".
 *
 * IDs and codes only: no message body, no recipient id.
 */
import type { ApprovalRequest } from "@/lib/types";

/** Current H1 code (Kimura 10/14). */
export const DELIVERY_UNSUPPORTED_SURFACE = "delivery_unsupported_surface";
/** Legacy alias — existing callers / stored tickets still match. */
export const CHANNEL_NOT_SUPPORTED = "channel_not_supported";
export const SLACK_CHANNEL_REQUIRED = "slack_channel_required";
/** Backstop: a conversation tool reached the end of invoke without a delivery record. */
export const CONVERSATION_NOT_SENT = "conversation_not_sent";

export function isUnsupportedSurfaceCode(code: string | null | undefined): boolean {
  return code === DELIVERY_UNSUPPORTED_SURFACE || code === CHANNEL_NOT_SUPPORTED;
}

/** Fulfillment / invoke codes that mean "stopped before any provider call: not sent". */
export const NOT_SENT_DESTINATION_CODES: ReadonlySet<string> = new Set([
  DELIVERY_UNSUPPORTED_SURFACE,
  CHANNEL_NOT_SUPPORTED,
  SLACK_CHANNEL_REQUIRED,
]);

const SURFACE_LABEL_JA: Record<string, string> = {
  line: "LINE",
  line_works: "LINE WORKS",
  telegram: "Telegram",
  mail: "メール",
  phone: "電話",
  web: "Web",
};

function surfaceLabelJa(surface: string | null | undefined): string {
  const s = (surface || "").toLowerCase();
  return SURFACE_LABEL_JA[s] || (s ? s : "この窓口");
}

function isNonSlack(surface: string | null | undefined): boolean {
  const s = (surface || "").toLowerCase();
  return Boolean(s) && s !== "slack";
}

export type NotSentInfo = {
  code: string;
  sent: false;
  surface: string | null;
  /** For the AI: what happened. */
  messageJa: string;
  /** For the AI: what to do next. */
  nextStep: string;
  /** For the approver's card: one line. */
  approverLineJa: string;
};

const DO_NOT_CLAIM = "相手には届いていません。送ったと伝えないでください。";

/** Direct invoke: the destination has no gateway delivery (nothing sent). */
export function channelNotSupportedInfo(surface: string | null | undefined): NotSentInfo {
  const label = surfaceLabelJa(surface);
  return {
    code: DELIVERY_UNSUPPORTED_SURFACE,
    sent: false,
    surface: surface ? String(surface).toLowerCase() : null,
    messageJa: surface
      ? `${label}への送信には、まだ対応していません。メッセージは送信していません。`
      : "送信先の窓口が分からないため、メッセージは送信していません。",
    nextStep: `${DO_NOT_CLAIM}Slack の会話であればそのスレッドで返信し直してください。それ以外の窓口の相手には、担当者から直接連絡してもらうよう Slack で依頼してください。同じ内容を繰り返し送らないでください。`,
    approverLineJa: `⚠️ ${label}への送信には対応していないため、送信していません。`,
  };
}

/** Approved, then stopped at fulfil because the destination can't be posted to. */
export function approvedNotSentInfo(code: string, surface: string | null | undefined): NotSentInfo {
  if (isNonSlack(surface) || isUnsupportedSurfaceCode(code)) {
    const label = surfaceLabelJa(surface);
    return {
      code,
      sent: false,
      surface: surface ? String(surface).toLowerCase() : null,
      messageJa: `承認されましたが、${label}への送信にはまだ対応していないため、送信していません。`,
      nextStep: `${DO_NOT_CLAIM}同じ承認で再実行しても送られません。相手には担当者から直接連絡してもらうよう、Slack で依頼してください。`,
      approverLineJa: `⚠️ 承認されましたが、${label}への送信には対応していないため、送信していません（AI 社員にも伝えています）。相手には別の方法で連絡してください。`,
    };
  }
  return {
    code,
    sent: false,
    surface: surface ? String(surface).toLowerCase() : null,
    messageJa: "承認されましたが、Slack の送信先（チャネル）が決まっていないため、送信していません。",
    nextStep: `${DO_NOT_CLAIM}チャネルを指定して（DM の場合は dm=true を付けて）、新しく依頼し直してください。同じ承認で再実行しても送られません。`,
    approverLineJa: "⚠️ 承認されましたが、Slack の送信先が決まっていないため、送信していません（AI 社員にも伝えています）。",
  };
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The approval's persisted fulfillment, when it is a "not sent" stop; else null. */
export function approvalNotSentInfo(metadata: Record<string, unknown> | null | undefined): NotSentInfo | null {
  const fulfillment = rec(metadata?.fulfillment);
  if (!fulfillment || fulfillment.ok !== false || typeof fulfillment.error !== "string") return null;
  if (!NOT_SENT_DESTINATION_CODES.has(fulfillment.error)) return null;
  const invoke = rec(metadata?.invoke);
  const conversation = rec(invoke?.conversation);
  const surface = typeof conversation?.surface === "string" ? conversation.surface : null;
  return approvedNotSentInfo(fulfillment.error, surface);
}

/** One extra line for the resolved approver card (Slack / LINE / Telegram); null when nothing to say. */
export function approverNotSentLineJa(approval: Pick<ApprovalRequest, "metadata">): string | null {
  return approvalNotSentInfo(approval.metadata)?.approverLineJa ?? null;
}

/** The status poll / MCP status `fulfillment` field for a not-sent stop. */
export function notSentFulfillmentResult(info: NotSentInfo): Record<string, unknown> {
  return {
    fulfilled: false,
    ok: false,
    sent: false,
    error: info.code,
    notSent: { code: info.code, messageJa: info.messageJa, nextStep: info.nextStep },
  };
}

/**
 * #351 follow-up: what the approval.resolved callback says about delivery.
 *   sent: true  — the approved message was posted (fulfillment delivery slack / mail; stub in demo)
 *   sent: false — nothing was sent (rejected / revision requested / expired, or the run
 *                 stopped: reasonCode is its code, e.g. slack_channel_required)
 *   sent: null  — not a send Staffpass performs, or not run yet (reasonCode null)
 * Codes only; never a body, token or destination.
 */
export function approvalSendOutcome(
  approval: { status?: string; metadata?: Record<string, unknown> | null },
  decision?: string | null
): { sent: boolean | null; reasonCode: string | null } {
  const status = decision || approval.status || "";
  if (status === "rejected" || status === "revision_requested" || status === "expired") {
    return { sent: false, reasonCode: status };
  }
  const fulfillment = rec(approval.metadata?.fulfillment);
  if (!fulfillment) return { sent: null, reasonCode: null };
  if (fulfillment.ok === false) {
    const raw = typeof fulfillment.error === "string" ? fulfillment.error : "";
    const code = /^[a-z][a-z0-9_.-]{0,63}/.exec(raw)?.[0] ?? "fulfillment_failed";
    return { sent: false, reasonCode: code };
  }
  const delivery = typeof fulfillment.delivery === "string" ? fulfillment.delivery : rec(fulfillment.conversationDelivery)?.delivery;
  if (delivery === "slack" || delivery === "mail" || delivery === "line") return { sent: true, reasonCode: null };
  if (delivery === "stub" && rec(approval.metadata?.invoke)?.conversation) return { sent: true, reasonCode: null };
  return { sent: null, reasonCode: null };
}
