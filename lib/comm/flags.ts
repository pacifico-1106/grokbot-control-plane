/**
 * LINE PoC flags (design line-lineworks-design-20261012.md). Every flag defaults
 * OFF; OFF = today's production behavior (no code path touches the new tables).
 * Kept out of lib/feature-flags.ts (many open PRs append to it).
 */

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/**
 * C5: per-employee LINE official accounts (employee_comm_accounts) and their
 * encrypted secrets. Requires migration 20261013200000 and
 * NOTIFICATION_CONFIG_ENCRYPTION_KEY. OFF → create / set / read refuse with
 * "disabled" and webhook-ref lookups find nothing (the route answers 404).
 */
export function isCommAccountsEnabled(): boolean {
  return parseFlag(process.env.COMM_ACCOUNTS_ENABLED);
}

/**
 * L1: LINE 1:1 conversation (wake from LINE, reply through comm.reply with a
 * server-signed conversation token). Needs COMM_ACCOUNTS_ENABLED as well.
 */
export function isLineConversationEnabled(): boolean {
  return isCommAccountsEnabled() && parseFlag(process.env.LINE_CONVERSATION_ENABLED);
}
