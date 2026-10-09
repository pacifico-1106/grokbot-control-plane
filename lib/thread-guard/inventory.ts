/**
 * Thread single-flight coverage per posting path (木村 2026-10-09 A). Every id
 * in lib/comm-reply-dedup/inventory.ts POSTING_PATH_INVENTORY must have a
 * decision here; inventory.test.ts fails otherwise, so a new posting path
 * cannot ship without saying whether it takes the thread lease.
 *
 *   leased       beginThreadSend (lease + thread_moved_on check) before the post
 *   same_reply   continuation of a reply that already passed the guard in the
 *                same request (lease released just before; never a new reply)
 *   no_thread    the surface has no conversation thread (dedup v2 still applies)
 *   no_live_send no provider call exists today; must call beginThreadSend when added
 *   not_ai_posting system notification plane, not an AI employee reply
 */
export type ThreadGuardCoverage = "leased" | "same_reply" | "no_thread" | "no_live_send" | "not_ai_posting";

export const THREAD_GUARD_COVERAGE: Readonly<Record<string, { coverage: ThreadGuardCoverage; where: string }>> = {
  "invoke.slack_post": { coverage: "leased", where: "lib/gateway/invoke.ts (Slack direct post; lease before the dedup claim)" },
  "invoke.caller_delivered": { coverage: "leased", where: "lib/gateway/invoke.ts (dest なし; allowed = recorded at server time)" },
  "fulfill.slack_post": { coverage: "leased", where: "lib/approvals/fulfill.ts (fulfillApprovedInvokeCore; rechecked at fulfil)" },
  "invoke.file_upload": { coverage: "same_reply", where: "only reached after the same request's reply passed the guard" },
  "rerun.attachment_upload": { coverage: "same_reply", where: "approved re-run attachment; the approved text was guarded at fulfil" },
  "invoke.sns_publish": { coverage: "no_thread", where: "sns.publish (no thread)" },
  "fulfill.sns_publish": { coverage: "no_thread", where: "sns.publish (no thread)" },
  "fulfill.mail_send": { coverage: "no_live_send", where: "no provider call today" },
  "drive.share_external": { coverage: "no_live_send", where: "no provider call today" },
  "notify.approval_cards": { coverage: "not_ai_posting", where: "system notification" },
  "notify.decision_voting_cards": { coverage: "not_ai_posting", where: "system notification" },
  "notify.transactional_email": { coverage: "not_ai_posting", where: "system notification" },
  "webhook.callback_answers": { coverage: "not_ai_posting", where: "system notification" },
  "lp.handoff_outbox": { coverage: "not_ai_posting", where: "system notification" },
  "admin.verification": { coverage: "not_ai_posting", where: "system notification" },
};
