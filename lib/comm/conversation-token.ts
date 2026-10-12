/**
 * Conversation token (design §2-3 C4, §2-5; holes H2, H3, H4).
 *
 * At wake, the server — which verified the inbound webhook signature — signs a
 * token that pins: org × employee × comm account × surface × conversation ×
 * counterparty × expiry. comm.reply on a non-Slack surface takes its
 * destination and counterparty ONLY from this token:
 *   - AI-supplied lineId / userId / channel / to / groupId never choose where a
 *     message goes (H2) and never make a counterparty "internal" (H3). A value
 *     that differs from the token is refused, not silently used.
 *   - The token carries no audience. WHO is decided at send time from the
 *     pinned counterparty against the org's ledger (linked members = internal,
 *     everyone else external). Groups are refused in the PoC (H4 is closed in
 *     L2 by looking up the group's own classification).
 *   - It is bound to the org AND employee whose credential presents it, so a
 *     token leaked to another tenant or another AI employee is useless.
 *
 * Format: spc1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>. Key
 * COMM_CONVERSATION_TOKEN_SECRET (≥ 32 chars; missing → fail closed);
 * COMM_CONVERSATION_TOKEN_SECRET_PREVIOUS is accepted for verify only (rotation).
 * Not encrypted: the payload holds IDs the AI already sees in the wake.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CONVERSATION_TOKEN_DEFAULT_TTL_SECONDS = 24 * 3600;
export const CONVERSATION_TOKEN_MAX_TTL_SECONDS = 7 * 24 * 3600;
const MAX_TOKEN_LENGTH = 2048;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINE_USER_RE = /^U[0-9a-f]{32}$/;
const LINE_GROUP_RE = /^[CR][0-9a-f]{32}$/;
const DOMAIN = "staffpass-conversation-token-v1";

export type ConversationSurface = "line";
export type ConversationTarget = {
  orgId: string;
  employeeId: string;
  accountId: string;
  surface: ConversationSurface;
  conversationType: "dm" | "group";
  conversationId: string;
  counterpartyId: string;
  expiresAt: string;
};
type Payload = { v: 1; org: string; emp: string; acct: string; sf: ConversationSurface; ct: "dm" | "group"; cid: string; cp: string; iat: number; exp: number; jti: string };

function keys(): { current: string; previous: string | null } | null {
  const current = process.env.COMM_CONVERSATION_TOKEN_SECRET?.trim() || "";
  if (current.length < 32) return null;
  const prev = process.env.COMM_CONVERSATION_TOKEN_SECRET_PREVIOUS?.trim() || "";
  return { current, previous: prev.length >= 32 ? prev : null };
}

function sign(key: string, payloadB64: string): Buffer {
  return createHmac("sha256", key).update(`${DOMAIN}.${payloadB64}`, "utf8").digest();
}

export function issueConversationToken(
  input: Omit<ConversationTarget, "expiresAt"> & { ttlSeconds?: number },
  nowMs: number = Date.now()
): { ok: true; token: string; expiresAt: string } | { ok: false; reason: string } {
  const k = keys();
  if (!k) return { ok: false, reason: "conversation_token_key_missing" };
  if (input.surface !== "line") return { ok: false, reason: "invalid_surface" };
  if (!UUID_RE.test(input.orgId) || !UUID_RE.test(input.employeeId) || !UUID_RE.test(input.accountId)) return { ok: false, reason: "invalid_ids" };
  if (!LINE_USER_RE.test(input.counterpartyId)) return { ok: false, reason: "invalid_counterparty" };
  if (input.conversationType === "group") {
    if (!LINE_GROUP_RE.test(input.conversationId)) return { ok: false, reason: "invalid_conversation" };
    return { ok: false, reason: "group_not_supported" }; // PoC: 1:1 only (L2 lifts this with the group ledger)
  }
  if (input.conversationType !== "dm") return { ok: false, reason: "invalid_conversation" };
  if (input.conversationId !== input.counterpartyId) return { ok: false, reason: "dm_counterparty_mismatch" };
  const ttl = Math.min(
    Math.max(1, Math.floor(Number(input.ttlSeconds ?? CONVERSATION_TOKEN_DEFAULT_TTL_SECONDS) || CONVERSATION_TOKEN_DEFAULT_TTL_SECONDS)),
    CONVERSATION_TOKEN_MAX_TTL_SECONDS
  );
  const iat = Math.floor(nowMs / 1000);
  const payload: Payload = {
    v: 1, org: input.orgId, emp: input.employeeId, acct: input.accountId, sf: input.surface,
    ct: input.conversationType, cid: input.conversationId, cp: input.counterpartyId,
    iat, exp: iat + ttl, jti: randomBytes(9).toString("base64url"),
  };
  const p = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { ok: true, token: `spc1.${p}.${sign(k.current, p).toString("base64url")}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

export function verifyConversationToken(
  token: string,
  presenter: { orgId: string; employeeId: string },
  nowMs: number = Date.now()
): { ok: true; target: ConversationTarget } | { ok: false; reason: string } {
  const k = keys();
  if (!k) return { ok: false, reason: "conversation_token_key_missing" };
  const invalid = { ok: false as const, reason: "conversation_token_invalid" };
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return invalid;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "spc1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return invalid;
  const given = Buffer.from(parts[2], "base64url");
  const good = [k.current, k.previous].filter((x): x is string => Boolean(x))
    .some((key) => { const exp = sign(key, parts[1]); return exp.length === given.length && timingSafeEqual(exp, given); });
  if (!good) return invalid;
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Payload;
  } catch {
    return invalid;
  }
  if (!p || typeof p !== "object" || Array.isArray(p) || p.v !== 1 || p.sf !== "line" || p.ct !== "dm"
      || typeof p.exp !== "number" || typeof p.org !== "string" || typeof p.emp !== "string"
      || !LINE_USER_RE.test(String(p.cp)) || p.cid !== p.cp || !UUID_RE.test(String(p.acct))) return invalid;
  if (p.org !== presenter.orgId) return { ok: false, reason: "conversation_token_wrong_org" };
  if (p.emp !== presenter.employeeId) return { ok: false, reason: "conversation_token_wrong_employee" };
  if (nowMs >= p.exp * 1000) return { ok: false, reason: "conversation_token_expired" };
  return {
    ok: true,
    target: { orgId: p.org, employeeId: p.emp, accountId: p.acct, surface: p.sf, conversationType: p.ct,
      conversationId: p.cid, counterpartyId: p.cp, expiresAt: new Date(p.exp * 1000).toISOString() },
  };
}

/** Argument names an AI might use to steer a non-Slack reply. Any that differ from the token → refused. */
const STEERING_ARGS = ["lineId", "userId", "user", "channel", "channelId", "to", "groupId", "roomId", "conversationId"] as const;

export function resolveConversationTarget(
  input: { token: string | null | undefined; args: Record<string, unknown>; orgId: string; employeeId: string },
  nowMs: number = Date.now()
): { ok: true; target: ConversationTarget } | { ok: false; reason: string } {
  if (!input.token) return { ok: false, reason: "conversation_token_required" };
  const v = verifyConversationToken(input.token, { orgId: input.orgId, employeeId: input.employeeId }, nowMs);
  if (!v.ok) return v;
  for (const name of STEERING_ARGS) {
    const raw = input.args?.[name];
    if (raw === undefined || raw === null || raw === "") continue;
    const s = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
    if (s !== v.target.conversationId && s !== v.target.counterpartyId) return { ok: false, reason: "conversation_target_mismatch" };
  }
  return v;
}
