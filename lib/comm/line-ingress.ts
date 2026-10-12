/**
 * L-4: per-employee LINE webhook (design §2-4, §2-6, §5; holes H7, H10, H11).
 * Route: POST /api/webhooks/line/c/<ref>. Flag LINE_CONVERSATION_ENABLED (needs
 * COMM_ACCOUNTS_ENABLED); OFF → 404 before anything is read.
 *
 * Order (nothing is written and no AI is woken before the signature passes):
 *   1. ref → ACTIVE account (unknown / pending / disabled → 404). The org and the
 *      employee come from this row only; nothing in the body selects them.
 *   2. that account's channel secret (unreadable → 503, fail closed)
 *   3. x-line-signature = base64(HMAC-SHA256(secret, raw body BYTES)), constant time → 401
 *      (the route reads the bytes capped at 1 MB; a decoded string is never signed)
 *   4. JSON (→ 400); `destination` must be this account's bot userId (→ 401)
 *   5. per event (first 100 only):
 *      - no webhookEventId → ignored (H7: no key, no dedup)
 *      - stale: older than 1 h and not a redelivery, or > 10 min in the future → dropped (H10)
 *      - webhookEventId recorded once per account (comm_inbound_events, no body);
 *        duplicate → skipped; storage error → skipped and the webhook answers 503
 *        so LINE redelivers (if redelivery is ON)
 *      - PoC: 1:1 text in active mode only (groups / rooms / media / follow → not dispatched)
 *      - a link code (SP-XXXX-XXXX) is never handed to the AI
 *      - emergency stop: checkOperable({phase:"wake"}) — held, unknown or error →
 *        not dispatched, audited (throttled), and never woken later (the event key
 *        is already consumed). Same rule as the Slack wake (S2 G5).
 *   6. a NEW conversation token for this message (org × employee × account ×
 *      sender, 24 h; 木村 10/12). No token key → not woken (fail closed).
 *   7. dispatch (L-5 wires the wake delivery). A dispatch error is logged and does
 *      not fail the webhook.
 * Sends are re-checked right before the LINE API call (lib/comm/pre-send): a stop
 * or leave placed after the token was issued still blocks the reply.
 * No message body is stored or logged (§7 decision 6).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getActiveCommAccountByWebhookRef,
  readCommAccountSecretsForServer,
  recordInboundEvent,
  type CommAccount,
} from "@/lib/comm/accounts";
import { issueConversationToken } from "@/lib/comm/conversation-token";
import { isLineConversationEnabled } from "@/lib/comm/flags";
import { checkOperable, takeWakeSuppressedAuditSlot, type OperableResult } from "@/lib/safety/hold";

export const LINE_MAX_EVENTS_PER_BODY = 100;
export const LINE_STALE_MS = 60 * 60_000;
export const LINE_FUTURE_SKEW_MS = 10 * 60_000;
const LINE_USER_RE = /^U[0-9a-f]{32}$/;
const LINK_CODE_RE = /^\s*[sSｓＳ][pPｐＰ][\s\-－]?[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]{4}[\s\-－]?[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]{4}\s*$/;

export type NormalizedLineEvent = {
  orgId: string;
  employeeId: string;
  accountId: string;
  surface: "line";
  conversationType: "dm";
  conversationId: string;
  senderId: string;
  text: string;
  eventKey: string;
  replyToken: string | null;
  receivedAt: string;
  /** server-signed, NEW for every counterparty message (木村 10/12); comm.reply resolves its target only from it */
  conversationToken: string;
  conversationTokenExpiresAt: string;
};

export type LineIngressDeps = {
  now: () => number;
  checkOperable: (i: { orgId?: string | null; employeeId?: string | null; phase: "wake" }) => Promise<OperableResult>;
  dispatch: (e: NormalizedLineEvent) => Promise<void>;
};

const defaultDeps: LineIngressDeps = {
  now: () => Date.now(),
  checkOperable: (i) => checkOperable(i),
  dispatch: async () => undefined, // L-5: wake with a conversation token
};

type LineEvent = {
  type?: string;
  mode?: string;
  timestamp?: number;
  webhookEventId?: string;
  deliveryContext?: { isRedelivery?: boolean };
  replyToken?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: { type?: string; text?: string };
};

export type LineIngressResult = { status: number; body: Record<string, unknown> };

/** HMAC over the RAW BYTES LINE signed (a string is taken as its UTF-8 bytes). */
function verify(secret: string, raw: Uint8Array, signature: string): boolean {
  if (!secret || !signature) return false;
  const a = createHmac("sha256", secret).update(raw).digest();
  let b: Buffer;
  try { b = Buffer.from(signature, "base64"); } catch { return false; }
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleLineAccountWebhook(
  input: { ref: string; rawBody: Uint8Array | string; signature: string },
  deps: Partial<LineIngressDeps> = {}
): Promise<LineIngressResult> {
  const d = { ...defaultDeps, ...deps };
  if (!isLineConversationEnabled()) return { status: 404, body: { ok: false, error: "not_found" } };
  const account = await getActiveCommAccountByWebhookRef(input.ref).catch(() => null);
  if (!account) return { status: 404, body: { ok: false, error: "not_found" } };
  const secrets = await readCommAccountSecretsForServer(account.orgId, account.id).catch(() => ({ ok: false as const, reason: "error" }));
  if (!secrets.ok) {
    console.error("line_account_webhook_secret_unavailable", { accountId: account.id, reason: secrets.reason });
    return { status: 503, body: { ok: false, error: "unavailable" } };
  }
  const rawBytes = typeof input.rawBody === "string" ? new TextEncoder().encode(input.rawBody) : input.rawBody;
  if (!verify(secrets.secrets.channelSecret, rawBytes, input.signature)) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  let parsed: { destination?: unknown; events?: unknown };
  try {
    // Decoded only after the signature passed; non-UTF-8 → 400 (fatal decode).
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    parsed = JSON.parse(text || "{}");
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }
  if (!parsed || typeof parsed !== "object" || parsed.destination !== account.externalAccountId) {
    return { status: 401, body: { ok: false, error: "destination_mismatch" } };
  }
  const events = Array.isArray(parsed.events) ? (parsed.events as LineEvent[]).slice(0, LINE_MAX_EVENTS_PER_BODY) : [];
  let retry = false;
  for (const ev of events) {
    const r = await processEvent(account, ev, d);
    if (r === "retry") retry = true;
  }
  return retry ? { status: 503, body: { ok: false, error: "retry" } } : { status: 200, body: { ok: true } };
}

async function processEvent(account: CommAccount, ev: LineEvent, d: LineIngressDeps): Promise<"done" | "retry"> {
  if (!ev || typeof ev !== "object") return "done";
  const key = typeof ev.webhookEventId === "string" ? ev.webhookEventId : "";
  if (!key) return "done";
  const now = d.now();
  const ts = typeof ev.timestamp === "number" ? ev.timestamp : NaN;
  const redelivery = ev.deliveryContext?.isRedelivery === true;
  if (!Number.isFinite(ts) || ts > now + LINE_FUTURE_SKEW_MS || (!redelivery && ts < now - LINE_STALE_MS)) return "done";
  const recorded = await recordInboundEvent(account, key);
  if (recorded === "duplicate" || recorded === "invalid") return "done";
  if (recorded === "error") return "retry";

  const src = ev.source || {};
  const sender = String(src.userId || "");
  const text = ev.type === "message" && ev.message?.type === "text" ? String(ev.message.text ?? "") : "";
  if (ev.mode === "standby" || src.type !== "user" || src.groupId || src.roomId || !LINE_USER_RE.test(sender) || !text) return "done";
  if (LINK_CODE_RE.test(text)) return "done"; // link codes are handled by the link flow (L-6), never by the AI

  let operable: OperableResult;
  try {
    operable = await d.checkOperable({ orgId: account.orgId, employeeId: account.employeeId, phase: "wake" });
  } catch {
    operable = { ok: false, code: "hold_state_unavailable", holdId: null, kind: null };
  }
  if (!operable.ok) {
    await auditSuppressed(account, operable);
    return "done";
  }
  const token = issueConversationToken(
    { orgId: account.orgId, employeeId: account.employeeId, accountId: account.id, surface: "line",
      conversationType: "dm", conversationId: sender, counterpartyId: sender,
      // L-5: pinned so the send path can use the free Reply without trusting the AI
      replyToken: typeof ev.replyToken === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(ev.replyToken) ? ev.replyToken : null },
    now
  );
  if (!token.ok) {
    console.error("line_wake_token_unavailable", { accountId: account.id, eventKey: key, reason: token.reason });
    return "done";
  }
  try {
    await d.dispatch({
      orgId: account.orgId,
      employeeId: account.employeeId,
      accountId: account.id,
      surface: "line",
      conversationType: "dm",
      conversationId: sender,
      senderId: sender,
      text,
      eventKey: key,
      replyToken: typeof ev.replyToken === "string" ? ev.replyToken : null,
      receivedAt: new Date(now).toISOString(),
      conversationToken: token.token,
      conversationTokenExpiresAt: token.expiresAt,
    });
  } catch {
    console.error("line_account_dispatch_failed", { accountId: account.id, eventKey: key });
  }
  return "done";
}

type AuditSink = (e: Parameters<typeof import("@/lib/data/audit").appendAuditEvent>[0]) => Promise<unknown>;
let auditSink: AuditSink | null = null;
/** Tests only. */
export function __setAuditSinkForTests(fn: AuditSink | null): void {
  auditSink = fn;
}

async function auditSuppressed(account: CommAccount, r: Extract<OperableResult, { ok: false }>): Promise<void> {
  const slot = takeWakeSuppressedAuditSlot(`${account.orgId}:${account.employeeId}:${r.code}`);
  if (!slot.write) return;
  try {
    const appendAuditEvent = auditSink ?? (await import("@/lib/data/audit")).appendAuditEvent;
    await appendAuditEvent({
      orgId: account.orgId,
      employeeId: account.employeeId,
      credentialId: null,
      action: "employee.hold.wake_suppressed",
      purpose: "comm.line",
      summary: "wake_suppressed_on_hold",
      metadata: { reason: r.code, holdId: r.holdId, trigger: "line_account_webhook", accountId: account.id, suppressedSinceLastRow: slot.suppressed },
    });
  } catch {
    // audit is best effort; the wake stays suppressed
  }
}
