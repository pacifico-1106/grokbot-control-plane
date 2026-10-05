/**
 * Posting-path inventory for the duplicate post guard (Yasaka / 木村
 * 2026-10-05, PR-A item 6). One shared mechanism — the hash-only ledger in
 * lib/comm-reply-dedup (guard.ts → lib/data/comm-reply-sends.ts) — covers every
 * path an AI employee posts through; there are no per-channel copies.
 * v2-rules.test.ts fails if an outbound-send tool (lib/gateway/tools.ts
 * OUTBOUND_SEND_TOOL_IDS) has no decision here.
 *
 * coverage:
 *   guarded          goes through the ledger (claim → post → finish)
 *   own_idempotency  already exactly-once by its own claim; not a new message
 *   no_live_send     no provider call exists today; must call the guard when added
 *   not_ai_posting   system notification plane (approval cards, alerts, OTPs):
 *                    not an AI employee post; has its own per-event idempotency
 */
import { DUPLICATE_GUARDED_TOOL_IDS } from "@/lib/gateway/tools";

export { DUPLICATE_GUARDED_TOOL_IDS };

export type PostingPathCoverage = "guarded" | "own_idempotency" | "no_live_send" | "not_ai_posting";

export type PostingPath = {
  id: string;
  /** Gateway tools that reach this path (empty for non-tool paths). */
  tools: readonly string[];
  surfaces: readonly string[];
  where: string;
  coverage: PostingPathCoverage;
  /** Flag that turns the guard on for this path. */
  flag?: "COMM_REPLY_DEDUP_ENABLED" | "DUPLICATE_GUARD_V2_ENABLED";
  noteJa: string;
};

const CONVERSATION_TOOLS = ["comm.reply", "comm.send", "slack.post", "slack.post_external"] as const;

export const POSTING_PATH_INVENTORY: readonly PostingPath[] = [
  {
    id: "invoke.slack_post",
    tools: CONVERSATION_TOOLS,
    surfaces: ["slack"],
    where: "lib/gateway/invoke.ts (postConversationMessage, bot / posting_as=user の代理投稿を含む)",
    coverage: "guarded",
    flag: "COMM_REPLY_DEDUP_ENABLED",
    noteJa: "会話ツールの Slack 直接投稿。MCP ツール・stuck-watch の再実行も runGatewayInvoke 経由でここを通る。",
  },
  {
    id: "invoke.caller_delivered",
    tools: CONVERSATION_TOOLS,
    surfaces: ["line", "telegram", "mail", "phone"],
    where: "lib/gateway/invoke.ts (dest なし: 呼び出し側が配送)",
    coverage: "guarded",
    flag: "COMM_REPLY_DEDUP_ENABLED",
    noteJa: "LINE / Telegram / メール面の会話返信は呼び出し側が配送する。許可した時点で台帳に sent として記録し、同じ判定で止める。",
  },
  {
    id: "invoke.file_upload",
    tools: ["comm.reply", "comm.send"],
    surfaces: ["slack"],
    where: "lib/gateway/invoke.ts (uploadSlackFile, initialComment 付き)",
    coverage: "guarded",
    flag: "DUPLICATE_GUARD_V2_ENABLED",
    noteJa: "メッセージ付きファイル共有。ファイル参照とファイル名とコメントの鍵付きハッシュで、同じチャネルへの同じ共有を 1 回にする。",
  },
  {
    id: "invoke.sns_publish",
    tools: ["sns.publish"],
    surfaces: ["x", "note", "linkedin", "youtube"],
    where: "lib/gateway/invoke.ts (publishSnsPost, 承認済み再実行)",
    coverage: "guarded",
    flag: "DUPLICATE_GUARD_V2_ENABLED",
    noteJa: "個人 SNS 投稿。会話キーは媒体 + 社員（アカウントは社員ごと）。",
  },
  {
    id: "fulfill.slack_post",
    tools: CONVERSATION_TOOLS,
    surfaces: ["slack"],
    where: "lib/approvals/fulfill.ts (承認後の送信: 即時 / MCP 再実行 / W2 / proxy)",
    coverage: "guarded",
    flag: "COMM_REPLY_DEDUP_ENABLED",
    noteJa: "保留承認の送信。v2 では 6 時間の窓、同じ jobId、送信結果不明の扱いも同じ台帳で判定する。",
  },
  {
    id: "fulfill.sns_publish",
    tools: ["sns.publish"],
    surfaces: ["x", "note", "linkedin", "youtube"],
    where: "lib/approvals/fulfill.ts (fulfillSnsPublish)",
    coverage: "guarded",
    flag: "DUPLICATE_GUARD_V2_ENABLED",
    noteJa: "承認後の SNS 投稿。同じ本文の 2 件目の承認は送らずに置き換え済みで閉じる。",
  },
  {
    id: "rerun.attachment_upload",
    tools: ["comm.reply", "comm.send"],
    surfaces: ["slack"],
    where: "lib/approvals/approved-rerun-attachment.ts",
    coverage: "own_idempotency",
    noteJa: "承認済み添付のアップロード。承認ごとのアップロード claim（migration 20261004300000）で 1 回だけ。本文は fulfill.slack_post が台帳で判定済み。",
  },
  {
    id: "fulfill.mail_send",
    tools: ["mail.send", "agentmail.send"],
    surfaces: ["mail"],
    where: "lib/approvals/fulfill.ts (fulfillMailSend: スタブ記録のみ)",
    coverage: "no_live_send",
    noteJa: "mail.send のライブ送信は未実装（記録のみ）。agentmail.send は予約で invoke が拒否。送信を実装するときは guard を通すこと。",
  },
  {
    id: "drive.share_external",
    tools: ["drive.share_external"],
    surfaces: ["drive"],
    where: "lib/gateway/invoke.ts",
    coverage: "no_live_send",
    noteJa: "共有リンクの発行で、会話へのメッセージ投稿ではない（常に人の承認）。",
  },
  {
    id: "notify.approval_cards",
    tools: [],
    surfaces: ["slack", "line", "telegram", "mail"],
    where: "lib/notify/* (承認カード・ダイジェスト・配送失敗アラート), lib/stuck-watch/notify-mouth.ts, webhook 返信",
    coverage: "not_ai_posting",
    noteJa: "承認者向けの通知面。AI 社員の投稿ではなく、承認 / イベントごとの冪等性を持つ（PR-B が並行で触るため変更しない）。",
  },
  {
    id: "notify.decision_voting_cards",
    tools: [],
    surfaces: ["slack", "telegram"],
    where: "lib/decision-workflow/notify.ts, lib/approval-workflow/*",
    coverage: "not_ai_posting",
    noteJa: "合議（投票）カードの通知。承認者向けで、AI 社員の会話投稿ではない。",
  },
  {
    id: "notify.transactional_email",
    tools: [],
    surfaces: ["mail"],
    where: "lib/email.ts, lib/resend.ts, lib/email-templates/*",
    coverage: "not_ai_posting",
    noteJa: "管理者向けのシステムメール（招待・承認通知など）。AI 社員のメール送信（mail.send）はスタブのみ。",
  },
  {
    id: "webhook.callback_answers",
    tools: [],
    surfaces: ["telegram", "slack"],
    where: "app/api/webhooks/telegram/[ref]/route.ts, Slack interactivity の ephemeral 応答",
    coverage: "not_ai_posting",
    noteJa: "ボタン押下への応答・カード更新。会話への新規投稿ではない。",
  },
  {
    id: "lp.handoff_outbox",
    tools: [],
    surfaces: ["slack_webhook"],
    where: "app/api/cron/lp-handoff-outbox/route.ts",
    coverage: "not_ai_posting",
    noteJa: "LP 問い合わせの社内通知。outbox の行ごとに 1 回送る。",
  },
  {
    id: "admin.verification",
    tools: [],
    surfaces: ["slack", "telegram"],
    where: "lib/approval-workflow/*-binding-verification.ts",
    coverage: "not_ai_posting",
    noteJa: "承認者の本人確認コード送信。会話への投稿ではない。",
  },
];
