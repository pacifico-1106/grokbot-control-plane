/**
 * L-3 (design §5 連携コードの総当たり, hole H8): #228's LINE link codes through
 * the brute-force limits of lib/comm/link-code-guard (migration 20261013200000).
 *
 * Flag LINE_LINK_CODE_LIMITS_ENABLED (default OFF = #228 as it is). It is forced
 * ON whenever LINE conversation is ON, because there a link code decides that a
 * LINE user counts as "internal".
 *
 * ON:
 * - ONE reservation BEFORE the code is looked up (#354, 木村 10/12): a locked sender
 *   (5 attempts in 15 min → 1 h) or a locked channel (30 in 1 h → 1 h, ops alerted
 *   once; the 3rd lock in 24 h also tells the tenant's approvers) is refused even
 *   with the right code, and that code stays unused. A right code gives its slot back.
 * - Every refusal gets the same single reply (it never tells whether a code exists).
 * - Guard storage unavailable → refused (fail closed), not counted.
 * - The account key is the approval channel ("line_channel:<channelId>"); the
 *   sender is stored only as an HMAC of the LINE userId.
 * Demo mode uses an in-memory backend with the same thresholds.
 */
import { isLineConversationEnabled } from "@/lib/comm/flags";
import {
  supabaseLinkCodeGuardBackend,
  withLinkCodeGuard,
  type LinkCodeGuardBackend,
  type LinkCodeReservation,
} from "@/lib/comm/link-code-guard";
import { consumeConversationLinkCode } from "@/lib/comm/conversation-link-code";
import { consumeLineLinkCode } from "@/lib/line/link-code";
import { isDemoMode } from "@/lib/mode";

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export function isLineLinkCodeLimitsEnabled(): boolean {
  return parseFlag(process.env.LINE_LINK_CODE_LIMITS_ENABLED) || isLineConversationEnabled();
}

export type RedeemLineLinkCodeResult =
  | { ok: true; memberId: string; issuedByUserId: string | null }
  | { ok: false; reason: string; replyJa: string | null };

// ---- demo backend (same semantics as comm_link_code_reserve_attempt) ----
const SENDER_WINDOW_MS = 15 * 60_000, SENDER_MAX = 5;
const ACCOUNT_WINDOW_MS = 60 * 60_000, ACCOUNT_MAX = 30;
const LOCK_MS = 60 * 60_000, REPEAT_WINDOW_MS = 24 * 3600_000, REPEAT_LOCKS = 3;
type DemoSlot = { t: number; id: string };
const demoAttempts = new Map<string, DemoSlot[]>();
const demoLocks = new Map<string, number>();
const demoLockEvents = new Map<string, number[]>();
const demoEscalated = new Map<string, number>();
let demoSeq = 0;
function demoBackend(now: () => number = Date.now): LinkCodeGuardBackend {
  const k = (org: string, kind: string, key: string) => `${org}|${kind}|${key}`;
  const locked = (key: string) => (demoLocks.get(key) ?? 0) > now();
  const recent = (key: string, win: number) => (demoAttempts.get(key) ?? []).filter((x) => x.t > now() - win);
  return {
    async reserve(org, acct, sender): Promise<LinkCodeReservation> {
      const t = now();
      const ak = k(org, "a", acct), sk = k(org, "s", sender);
      if (locked(ak)) return { result: "account_locked", attemptId: null, notify: null };
      if (locked(sk)) return { result: "sender_locked", attemptId: null, notify: null };
      if (recent(sk, SENDER_WINDOW_MS).length >= SENDER_MAX) {
        demoLocks.set(sk, t + LOCK_MS);
        return { result: "sender_locked", attemptId: null, notify: null };
      }
      if (recent(ak, ACCOUNT_WINDOW_MS).length >= ACCOUNT_MAX) {
        demoLocks.set(ak, t + LOCK_MS);
        const events = [...(demoLockEvents.get(ak) ?? []).filter((x) => x > t - REPEAT_WINDOW_MS), t];
        demoLockEvents.set(ak, events);
        const esc = demoEscalated.get(ak);
        if (events.length >= REPEAT_LOCKS && (esc === undefined || esc <= t - REPEAT_WINDOW_MS)) {
          demoEscalated.set(ak, t);
          return { result: "account_locked", attemptId: null, notify: "account_locked_repeat" };
        }
        return { result: "account_locked", attemptId: null, notify: "account_locked" };
      }
      const id = `demo-${++demoSeq}`;
      for (const key of [ak, sk]) demoAttempts.set(key, [...recent(key, 24 * 3600_000), { t, id }].slice(-200));
      return { result: "ok", attemptId: id, notify: null };
    },
    async release(org, attemptId) {
      for (const [key, arr] of demoAttempts) if (key.startsWith(`${org}|`)) demoAttempts.set(key, arr.filter((x) => x.id !== attemptId));
    },
    async alertOps(p) {
      console.warn("comm_link_code_account_locked (demo)", { orgId: p.orgId, accountKey: p.accountKey });
    },
    async alertRepeat(p) {
      console.warn("comm_link_code_account_locked_repeat (demo)", { orgId: p.orgId, accountKey: p.accountKey });
    },
  };
}

let backendOverride: LinkCodeGuardBackend | "none" | null = null;
export function __setLineLinkCodeGuardBackendForTests(b: LinkCodeGuardBackend | "none" | null): void {
  backendOverride = b;
  if (b === null) { demoAttempts.clear(); demoLocks.clear(); demoLockEvents.clear(); demoEscalated.clear(); }
}

async function guardBackend(): Promise<LinkCodeGuardBackend | null> {
  if (backendOverride === "none") return null;
  if (backendOverride) return backendOverride;
  if (isDemoMode()) return demoBackend();
  return supabaseLinkCodeGuardBackend();
}

const UNAVAILABLE: LinkCodeGuardBackend = {
  async reserve() { throw new Error("link_code_guard_unavailable"); },
  async release() { throw new Error("link_code_guard_unavailable"); },
  async alertOps() {},
  async alertRepeat() {},
};

/** The webhook's only way to redeem a link code. */
export async function redeemLineLinkCode(input: {
  orgId: string;
  channelId: string;
  code: string;
  lineUserId: string;
}): Promise<RedeemLineLinkCodeResult> {
  if (!isLineLinkCodeLimitsEnabled()) {
    const r = await consumeLineLinkCode(input);
    return r.ok ? r : { ok: false, reason: r.reason, replyJa: null };
  }
  const backend = (await guardBackend()) ?? UNAVAILABLE;
  const r = await withLinkCodeGuard(
    backend,
    { orgId: input.orgId, accountKey: `line_channel:${input.channelId}`, lineUserId: input.lineUserId },
    async () => {
      const c = await consumeLineLinkCode(input);
      return c.ok ? { ok: true as const, value: c } : { ok: false as const, reason: c.reason };
    }
  );
  if (r.ok) return { ok: true, memberId: r.value.memberId, issuedByUserId: r.value.issuedByUserId };
  return { ok: false, reason: r.reason, replyJa: r.replyJa };
}

/** Conversation (comm account) redeem — same guard, own table (M1). */
export async function redeemConversationLinkCodeGuarded(input: {
  orgId: string;
  accountId: string;
  code: string;
  lineUserId: string;
}): Promise<RedeemLineLinkCodeResult> {
  const consume = () =>
    consumeConversationLinkCode({
      orgId: input.orgId,
      accountId: input.accountId,
      code: input.code,
      lineUserId: input.lineUserId,
    });
  if (!isLineLinkCodeLimitsEnabled()) {
    const r = await consume();
    return r.ok ? r : { ok: false, reason: r.reason, replyJa: null };
  }
  const backend = (await guardBackend()) ?? UNAVAILABLE;
  const r = await withLinkCodeGuard(
    backend,
    { orgId: input.orgId, accountKey: `comm_account:${input.accountId}`, lineUserId: input.lineUserId },
    async () => {
      const c = await consume();
      return c.ok ? { ok: true as const, value: c } : { ok: false as const, reason: c.reason };
    }
  );
  if (r.ok) return { ok: true, memberId: r.value.memberId, issuedByUserId: r.value.issuedByUserId };
  return { ok: false, reason: r.reason, replyJa: r.replyJa };
}
