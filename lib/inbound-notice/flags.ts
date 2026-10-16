/**
 * Inbound call-notice prototype (docs/design/inbound-call-notice-20261016.md).
 * Default OFF: mention-ingress never enters this path. Kept out of
 * lib/feature-flags.ts (many open PRs append to it).
 */

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/** INBOUND_CALL_NOTICE_ENABLED. Unset / empty / anything else → OFF. */
export function isInboundCallNoticeEnabled(): boolean {
  return parseFlag(process.env.INBOUND_CALL_NOTICE_ENABLED);
}
