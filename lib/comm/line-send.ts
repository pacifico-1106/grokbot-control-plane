/**
 * L-5: the LINE send path for an AI employee's own official account (design §2-2 ③,
 * §2-5, §2-6; holes H1–H3). Flag LINE_CONVERSATION_ENABLED (default OFF).
 *
 * Order (every refusal sends nothing):
 *   1. text: a string of 1–5000 characters (never truncated silently)
 *   2. conversation token → target (resolveConversationTarget): org × employee ×
 *      account × counterparty come ONLY from the server-signed token; an AI argument
 *      that names another destination is refused
 *   3. audience, decided now from the ledger: the counterparty is internal only if
 *      linked with a link code (voter binding provider 'line', channel_key
 *      'comm_account:<accountId>', active). Not linked → external. Read error → refused.
 *   4. external → refused unless the caller passes externalSendAllowed (reply_policy
 *      allowed it, or a human approved). Default: refused (§7 decision 5).
 *   5. the account's access token (server-only read)
 *   6. checkLineSendAllowed — LAST, right before the API: account active, link not
 *      removed (when internal), employee / org not on stop / leave / quarantine
 *   7. Reply when the pinned replyToken is fresh (< 50 s) and unused in the
 *      reply-token ledger (DB / demo; not process memory). A 400 on Reply
 *      (token expired / used) falls back to Push. Push carries X-Line-Retry-Key
 *      so a retry can't double-send (409 = already accepted).
 *   8. result: sent / not_sent / unknown (5xx, timeout, network: may or may not have
 *      been delivered → never retried blindly, never followed by a Push).
 * The message text and the access token are never logged.
 */
import { readCommAccountSecretsForServer } from "@/lib/comm/accounts";
import { resolveConversationTarget } from "@/lib/comm/conversation-token";
import { isLineConversationEnabled } from "@/lib/comm/flags";
import { checkLineSendAllowed, type PreSendResult, type PreSendTarget } from "@/lib/comm/pre-send";
import { claimLineReplyToken, __resetLineReplyTokenLedgerForTests } from "@/lib/comm/reply-token-ledger";

export const LINE_TEXT_MAX = 5000;
export const LINE_REPLY_FRESH_MS = 50_000;
const LINE_API = "https://api.line.me";
const TIMEOUT_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LineSendResult =
  | { status: "sent"; audience: "internal" | "external"; mode: "reply" | "push" }
  | { status: "not_sent"; reason: string; audience?: "internal" | "external"; mode?: "reply" | "push"; httpStatus?: number }
  | { status: "unknown"; reason: string; audience: "internal" | "external"; mode: "reply" | "push"; httpStatus?: number };

export type LineSendDeps = {
  now: () => number;
  getLink: (orgId: string, channelKey: string, lineUserId: string) => Promise<{ status: string } | null>;
  readSecrets: typeof readCommAccountSecretsForServer;
  checkLineSendAllowed: (t: PreSendTarget) => Promise<PreSendResult>;
  claimReplyToken: typeof claimLineReplyToken;
};

const defaultDeps: LineSendDeps = {
  now: () => Date.now(),
  async getLink(orgId, channelKey, lineUserId) {
    const { getVoterBinding } = await import("@/lib/approval-workflow/voter-binding");
    return getVoterBinding(orgId, "line", channelKey, lineUserId);
  },
  readSecrets: (o, a) => readCommAccountSecretsForServer(o, a),
  checkLineSendAllowed: (t) => checkLineSendAllowed(t),
  claimReplyToken: (input) => claimLineReplyToken(input),
};

/** Tests only. */
export function __resetLineSendForTests(): void {
  __resetLineReplyTokenLedgerForTests();
}

type Http = { kind: "ok" } | { kind: "status"; status: number } | { kind: "network" };
async function post(path: string, accessToken: string, body: unknown, extra: Record<string, string> = {}): Promise<Http> {
  try {
    const res = await fetch(`${LINE_API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, ...extra },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? { kind: "ok" } : { kind: "status", status: res.status };
  } catch {
    return { kind: "network" };
  }
}

export async function sendLineConversationMessage(
  input: {
    token: string | null | undefined;
    args: Record<string, unknown>;
    text: unknown;
    orgId: string;
    employeeId: string;
    /** true only when reply_policy allows an external send or a human approved this one */
    externalSendAllowed: boolean;
    /** stable per logical send (e.g. the job / approval id) so a retry can't double-send */
    retryKey: string;
  },
  deps: Partial<LineSendDeps> = {}
): Promise<LineSendResult> {
  const d = { ...defaultDeps, ...deps };
  if (!isLineConversationEnabled()) return { status: "not_sent", reason: "line_conversation_disabled" };
  if (typeof input.text !== "string" || input.text.trim() === "" || [...input.text].length > LINE_TEXT_MAX) {
    return { status: "not_sent", reason: "invalid_text" };
  }
  if (!UUID_RE.test(String(input.retryKey || ""))) return { status: "not_sent", reason: "invalid_retry_key" };
  const now = d.now();
  const resolved = resolveConversationTarget({ token: input.token, args: input.args || {}, orgId: input.orgId, employeeId: input.employeeId }, now);
  if (!resolved.ok) return { status: "not_sent", reason: resolved.reason };
  const t = resolved.target;

  let audience: "internal" | "external";
  try {
    const link = await d.getLink(t.orgId, `comm_account:${t.accountId}`, t.counterpartyId);
    audience = link && link.status === "active" ? "internal" : "external";
  } catch {
    return { status: "not_sent", reason: "counterparty_link_unavailable" };
  }
  if (audience === "external" && input.externalSendAllowed !== true) {
    return { status: "not_sent", reason: "external_send_needs_approval", audience };
  }

  const secrets = await d.readSecrets(t.orgId, t.accountId).catch(() => ({ ok: false as const, reason: "error" }));
  if (!secrets.ok) {
    console.error("line_send_secret_unavailable", { accountId: t.accountId, reason: secrets.reason });
    return { status: "not_sent", reason: "comm_account_secret_unavailable", audience };
  }

  const allowed = await d
    .checkLineSendAllowed({ orgId: t.orgId, employeeId: t.employeeId, accountId: t.accountId, counterpartyId: t.counterpartyId, requiresLink: audience === "internal" })
    .catch(() => ({ ok: false as const, reason: "hold_state_unavailable" as const }));
  if (!allowed.ok) return { status: "not_sent", reason: allowed.reason, audience };

  const accessToken = secrets.secrets.channelAccessToken;
  const messages = [{ type: "text", text: input.text }];
  const rt = t.replyToken;
  if (rt && now - Date.parse(t.issuedAt) < LINE_REPLY_FRESH_MS) {
    const claim = await d.claimReplyToken({ orgId: t.orgId, accountId: t.accountId, replyToken: rt });
    if (!claim.ok) {
      console.error("line_reply_token_claim_failed", { accountId: t.accountId, reason: claim.reason });
      return { status: "not_sent", reason: claim.reason, audience };
    }
    if (claim.claimed) {
      const r = await post("/v2/bot/message/reply", accessToken, { replyToken: rt, messages });
      if (r.kind === "ok") return { status: "sent", audience, mode: "reply" };
      if (r.kind === "network") {
        console.error("line_send_unknown", { accountId: t.accountId, mode: "reply", reason: "line_network_error" });
        return { status: "unknown", reason: "line_network_error", audience, mode: "reply" };
      }
      if (r.status >= 500) {
        console.error("line_send_unknown", { accountId: t.accountId, mode: "reply", status: r.status });
        return { status: "unknown", reason: "line_http_5xx", audience, mode: "reply", httpStatus: r.status };
      }
      if (r.status !== 400) return { status: "not_sent", reason: r.status === 429 ? "line_rate_limited" : "line_http_4xx", audience, mode: "reply", httpStatus: r.status };
      // 400: replyToken expired / already used → nothing was delivered → Push
    }
  }
  const r = await post("/v2/bot/message/push", accessToken, { to: t.counterpartyId, messages }, { "x-line-retry-key": input.retryKey });
  if (r.kind === "ok") return { status: "sent", audience, mode: "push" };
  if (r.kind === "network") {
    console.error("line_send_unknown", { accountId: t.accountId, mode: "push", reason: "line_network_error" });
    return { status: "unknown", reason: "line_network_error", audience, mode: "push" };
  }
  if (r.status === 409) return { status: "sent", audience, mode: "push" }; // same X-Line-Retry-Key already accepted
  if (r.status >= 500) {
    console.error("line_send_unknown", { accountId: t.accountId, mode: "push", status: r.status });
    return { status: "unknown", reason: "line_http_5xx", audience, mode: "push", httpStatus: r.status };
  }
  return { status: "not_sent", reason: r.status === 429 ? "line_rate_limited" : "line_http_4xx", audience, mode: "push", httpStatus: r.status };
}
