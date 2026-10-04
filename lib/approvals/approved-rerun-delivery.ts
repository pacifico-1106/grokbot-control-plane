import type { ApprovalFulfillment, ConversationDelivery } from "@/lib/approvals/fulfill";

export type ApprovedRerunDelivery =
  | { ok: true; delivery: ConversationDelivery }
  | { ok: false; code: string; messageJa: string };

/**
 * Approved conversation re-run (comm.reply / comm.send / slack.post /
 * slack.post_external with approvalId): the result of fulfilling the APPROVED
 * snapshot, never a new post of the re-run request's text.
 *
 * A Slack "stub" record means nothing was sent. Demo mode reports it as the
 * stub it is. In production it can only be a legacy record from before the
 * fail-closed change (no token at approval time); its execution claim is
 * already "succeeded", so it is reported as slack_token_missing (re-approve)
 * instead of a fake ok.
 */
export function approvedRerunConversationDelivery(
  fulfillment: ApprovalFulfillment,
  options: { demo: boolean }
): ApprovedRerunDelivery {
  if (!fulfillment.ok) {
    const code = fulfillment.error || "approval_execution_failed";
    return { ok: false, code, messageJa: "承認済みの投稿に失敗しました" };
  }
  if (fulfillment.delivery === "slack" || fulfillment.delivery === "mail") {
    return {
      ok: true,
      delivery: {
        ok: true,
        delivery: fulfillment.delivery,
        ...(fulfillment.channel ? { channel: fulfillment.channel } : {}),
        ...(fulfillment.ts ? { ts: fulfillment.ts } : {}),
      },
    };
  }
  if (options.demo) return { ok: true, delivery: { ok: true, delivery: "stub" } };
  return {
    ok: false,
    code: "slack_token_missing",
    messageJa:
      "承認済みの投稿は送信されていません（承認時に Slack トークンがありませんでした）。トークン登録後に改めて承認を取り直してください",
  };
}
