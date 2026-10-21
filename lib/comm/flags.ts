/**
 * LINE PoC flags (design line-lineworks-design-20261012.md). Every flag defaults
 * OFF; OFF = today's production behavior (no code path touches the new tables).
 * Kept out of lib/feature-flags.ts (many open PRs append to it).
 *
 * U-09 (木村): COMM_ACCOUNTS_ENABLED / LINE_CONVERSATION_ENABLED can be narrowed
 * to an org allowlist. Default is all orgs OFF (flags unset). When a flag is ON
 * and its `*_ORG_IDS` list is empty, every org is ON (dev / existing tests).
 * Production sets the list to TOKYO307 only. Unknown / malformed ids are ignored;
 * a list that contains no valid UUID is fail-closed (no org matches).
 */

const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/** `null` = no restriction (flag ON applies to every org). Empty set = deny all. */
export function parseOrgAllowlist(raw: string | undefined): Set<string> | null {
  const items = (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0) return null;
  return new Set(items.filter((id) => ORG_UUID_RE.test(id)));
}

function orgScopedOn(flagOn: boolean, allowlistEnv: string | undefined, orgId?: string | null): boolean {
  if (!flagOn) return false;
  const allowed = parseOrgAllowlist(allowlistEnv);
  if (!allowed) return true;
  if (!orgId) return true;
  return allowed.has(orgId.trim().toLowerCase());
}

/**
 * C5: per-employee LINE official accounts (employee_comm_accounts) and their
 * encrypted secrets. Requires migration 20261013200000 and
 * NOTIFICATION_CONFIG_ENCRYPTION_KEY. OFF → create / set / read refuse with
 * "disabled" and webhook-ref lookups find nothing (the route answers 404).
 * Pass orgId to apply COMM_ACCOUNTS_ORG_IDS (U-09).
 */
export function isCommAccountsEnabled(orgId?: string | null): boolean {
  return orgScopedOn(parseFlag(process.env.COMM_ACCOUNTS_ENABLED), process.env.COMM_ACCOUNTS_ORG_IDS, orgId);
}

/**
 * L1: LINE 1:1 conversation (wake from LINE, reply through comm.reply with a
 * server-signed conversation token). Needs COMM_ACCOUNTS_ENABLED as well.
 * Pass orgId to apply LINE_CONVERSATION_ORG_IDS (U-09).
 */
export function isLineConversationEnabled(orgId?: string | null): boolean {
  return (
    isCommAccountsEnabled(orgId) &&
    orgScopedOn(parseFlag(process.env.LINE_CONVERSATION_ENABLED), process.env.LINE_CONVERSATION_ORG_IDS, orgId)
  );
}

/**
 * L-8: owner/admin connect may GET /v2/bot/info, PUT the conversation webhook
 * URL, and POST /v2/bot/channel/webhook/test. Needs the conversation flags.
 * Default OFF. AI / Admin MCP never call this path.
 */
export function isLineWebhookAutoSetupEnabled(orgId?: string | null): boolean {
  return isLineConversationEnabled(orgId) && parseFlag(process.env.LINE_WEBHOOK_AUTO_SETUP_ENABLED);
}

/**
 * Until passkeys: refuse high-risk LINE postback approve.
 * Default OFF so existing `/api/webhooks/line/<ref>` stays as main.
 * Conversation ON for an org forces this gate on.
 * LINE_WEB_ONLY_HIGH_RISK_ORG_IDS narrows the flag (missing orgId → off).
 */
export function isLineWebOnlyHighRiskEnabled(orgId?: string | null): boolean {
  if (isLineConversationEnabled(orgId)) return true;
  if (!parseFlag(process.env.LINE_WEB_ONLY_HIGH_RISK_ENABLED)) return false;
  const allowed = parseOrgAllowlist(process.env.LINE_WEB_ONLY_HIGH_RISK_ORG_IDS);
  if (!allowed) return true;
  if (!orgId) return false;
  return allowed.has(orgId.trim().toLowerCase());
}
