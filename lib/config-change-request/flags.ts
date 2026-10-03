/**
 * config.change_request local flags (kept out of lib/feature-flags.ts, which
 * several open PRs edit).
 */
function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/**
 * P1_CONFIG_CHANGE_REQUESTER_VERIFY_ENFORCE (default OFF).
 *
 * ON: refuse a config change request unless the declared requester
 * (requestedBy.slackUserId) matches the real Slack speaker recorded when the AI
 * employee was woken (requester-verify.ts). Nothing is created.
 * OFF: the request still goes to the approver, with the check result shown on
 * the card (未確認 / ⚠ 不一致) — this part is always on (stricter copy only).
 */
export function isConfigChangeRequesterVerifyEnforced(): boolean {
  return parseFlag(process.env.P1_CONFIG_CHANGE_REQUESTER_VERIFY_ENFORCE);
}
