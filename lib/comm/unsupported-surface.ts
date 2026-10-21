/**
 * Common component C — H1 (design §6).
 * A destination with no gateway adapter must fail closed as "not sent".
 * Never drop silently and never post to another surface.
 *
 * DELIVERY_UNSUPPORTED_SURFACE_ENABLED default OFF: today's main (empty dest
 * already returns 409). ON: a declared non-Slack surface is refused even when
 * Slack dest fields are also present.
 */
import { getCommAccountInOrg } from "@/lib/comm/accounts";
import { conversationTokenFromRequest, verifyConversationToken } from "@/lib/comm/conversation-token";
import { parseOrgAllowlist } from "@/lib/comm/flags";

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export function isDeliveryUnsupportedSurfaceEnabled(orgId?: string | null): boolean {
  if (!parseFlag(process.env.DELIVERY_UNSUPPORTED_SURFACE_ENABLED)) return false;
  const allowed = parseOrgAllowlist(process.env.DELIVERY_UNSUPPORTED_SURFACE_ORG_IDS);
  if (!allowed) return true;
  if (!orgId) return false;
  return allowed.has(orgId.trim().toLowerCase());
}

/** Surface the caller named — not one inferred from Slack dest fields. */
export function declaredConversationSurface(body: {
  conversation?: { surface?: unknown } | null;
  surface?: unknown;
  args?: { surface?: unknown; channelSurface?: unknown } | null;
}): string | null {
  const conv = body.conversation && typeof body.conversation === "object" ? body.conversation : {};
  const args = body.args && typeof body.args === "object" ? body.args : {};
  const raw = conv.surface ?? body.surface ?? args.surface ?? args.channelSurface;
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return s || null;
}

export function unsupportedSurfaceDeliveryVerdict(input: {
  surface?: string | null;
  lineConversation?: boolean;
}): { refuse: boolean; surface: string | null } {
  const surface = (input.surface || "").trim().toLowerCase() || null;
  if (!surface || surface === "slack") return { refuse: false, surface };
  if (surface === "line" && input.lineConversation) return { refuse: false, surface };
  return { refuse: true, surface };
}

/**
 * LINE is the only non-Slack exception, and only with a server-signed 札:
 * HMAC, presenter org × employee, and the account row for that pair.
 * A garbage / leaked / swapped token must not skip H1 (no unsendable card).
 */
export async function verifiedLineConversationException(input: {
  body: { conversation?: unknown; args?: unknown; token?: unknown };
  orgId: string;
  employeeId: string;
}): Promise<boolean> {
  const token = conversationTokenFromRequest(input.body);
  if (!token) return false;
  const v = verifyConversationToken(token, { orgId: input.orgId, employeeId: input.employeeId });
  if (!v.ok) return false;
  const account = await getCommAccountInOrg(v.target.orgId, v.target.accountId).catch(() => null);
  if (!account) return false;
  return (
    account.orgId === input.orgId &&
    account.employeeId === input.employeeId &&
    account.surface === "line" &&
    account.id === v.target.accountId
  );
}
