/**
 * Why an approval was closed WITHOUT sending (metadata.closedWithoutSend,
 * written by lib/data/approvals.ts closeApprovalWithoutSend), as approver /
 * AI facing wording. Pure (no server imports): used by the status API, the
 * employee MCP status tool and the Web result page (components/ApprovalsClient).
 * The wording comes from this table only; the stored reason string is never
 * rendered into the message.
 */
export const THREAD_MOVED_ON_CLOSE_REASON = "thread_moved_on";

const MESSAGES_JA: Record<string, string> = {
  thread_moved_on:
    "送信していません: 承認後、送信する前に、AI 社員の読んだ時点より後でスレッドに AI 社員の投稿があり、内容が古くなったため終了しました（スレッドが先に進みました）。",
  newer_reply_sent: "送信していません: 同じ会話に同じ / 類似の内容の返信がすでに送られたため終了しました。",
  newer_approval_requested: "送信していません: 同じ会話の新しい承認依頼に置き換えられたため終了しました。",
  replied_after_approval: "送信していません: 承認後に同じ会話へ同じ / 類似の内容の返信が送られたため終了しました。",
  approval_ttl_elapsed: "送信していません: 承認の有効期限が過ぎたため終了しました。",
};
const GENERIC_JA = "送信していません: この承認は送信せずに終了しました。";

const NEXT_STEP: Record<string, string> = {
  thread_moved_on:
    "Not sent: the thread moved on (an AI employee posted after the approved read point), so this approval was closed as stale. Do not re-run this approvalId. Re-read the thread and file a new request only if a reply is still needed.",
};
const GENERIC_NEXT_STEP = "Not sent: this approval was closed without sending. Do not re-run this approvalId or re-send the same content.";

export type ClosedWithoutSendInfo = { reason: string; messageJa: string; nextStep: string };

export function closedWithoutSendInfo(metadata: Record<string, unknown> | null | undefined): ClosedWithoutSendInfo | null {
  const closed = metadata?.closedWithoutSend;
  if (!closed || typeof closed !== "object" || Array.isArray(closed)) return null;
  const reason = (closed as Record<string, unknown>).reason;
  if (typeof reason !== "string" || !reason) return null;
  const known = Object.prototype.hasOwnProperty.call(MESSAGES_JA, reason);
  return {
    reason,
    messageJa: known ? MESSAGES_JA[reason] : GENERIC_JA,
    nextStep: Object.prototype.hasOwnProperty.call(NEXT_STEP, reason) ? NEXT_STEP[reason] : GENERIC_NEXT_STEP,
  };
}

export function closedByThreadMovedOn(metadata: Record<string, unknown> | null | undefined): boolean {
  return closedWithoutSendInfo(metadata)?.reason === THREAD_MOVED_ON_CLOSE_REASON;
}
