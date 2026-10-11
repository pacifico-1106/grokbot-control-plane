/**
 * How much of approval.summary each approval surface shows (#275 B1).
 * Slack cuts the summary section at 400 chars (lib/notify/slack.ts), LINE's
 * Flex text at 500 (lib/notify/line.ts); Telegram only trims past its
 * 4096-char message limit. A summary at or under the shortest cut is shown in
 * full everywhere, so a card whose meaning depends on every line (policy.patch
 * SoD verdict) must stay within it.
 */
export const SLACK_APPROVAL_SUMMARY_MAX_CHARS = 400;
export const LINE_APPROVAL_SUMMARY_MAX_CHARS = 500;
export const APPROVAL_SUMMARY_FULL_ON_ALL_SURFACES_MAX_CHARS = Math.min(
  SLACK_APPROVAL_SUMMARY_MAX_CHARS,
  LINE_APPROVAL_SUMMARY_MAX_CHARS
);

/** Characters as the surfaces count them (code points, same as their truncate()). */
export function approvalSummaryChars(summary: string): number {
  return Array.from(summary).length;
}

/** True when no surface would cut this summary. */
export function approvalSummaryFitsAllSurfaces(summary: string): boolean {
  return approvalSummaryChars(summary) <= APPROVAL_SUMMARY_FULL_ON_ALL_SURFACES_MAX_CHARS;
}
