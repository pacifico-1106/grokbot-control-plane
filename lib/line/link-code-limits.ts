/**
 * L-3 (design §5 連携コードの総当たり, hole H8): #228's LINE link codes through
 * the brute-force limits of lib/comm/link-code-guard (migration 20261013200000).
 *
 * Flag LINE_LINK_CODE_LIMITS_ENABLED (default OFF = #228 as it is). It is forced
 * ON whenever LINE conversation is ON, because there a link code decides that a
 * LINE user counts as "internal".
 *
 * ON:
 * - The gate runs BEFORE the code is looked up: a locked sender (5 wrong in
 *   15 min → 1 h) or a locked channel (30 wrong in 1 h → 1 h, ops alerted once)
 *   is refused even with the right code, and that code stays unused.
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
  type LinkCodeGate,
  type LinkCodeGuardBackend,
  type LinkCodeRecord,
} from "@/lib/comm/link-code-guard";
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

// ---- demo backend (same thresholds as the SQL functions) ----
const SENDER_WINDOW_MS = 15 * 60_000, SENDER_MAX = 5;
const ACCOUNT_WINDOW_MS = 60 * 60_000, ACCOUNT_MAX = 30;
const LOCK_MS = 60 * 60_000;
const demoFailures = new Map<string, number[]>();
const demoLocks = new Map<string, number>();
function demoBackend(now: () => number = Date.now): LinkCodeGuardBackend {
  const k = (org: string, kind: string, key: string) => `${org}|${kind}|${key}`;
  const locked = (key: string) => (demoLocks.get(key) ?? 0) > now();
  return {
    async gate(org, acct, sender): Promise<LinkCodeGate> {
      if (locked(k(org, "a", acct))) return "account_locked";
      if (locked(k(org, "s", sender))) return "sender_locked";
      return "ok";
    },
    async recordFailure(org, acct, sender): Promise<LinkCodeRecord> {
      const t = now();
      const push = (key: string, win: number) => {
        const arr = (demoFailures.get(key) ?? []).filter((x) => x > t - win);
        arr.push(t);
        demoFailures.set(key, arr.slice(-100));
        return arr.length;
      };
      const ak = k(org, "a", acct), sk = k(org, "s", sender);
      const a = push(ak, ACCOUNT_WINDOW_MS), s = push(sk, SENDER_WINDOW_MS);
      if (a >= ACCOUNT_MAX && !locked(ak)) { demoLocks.set(ak, t + LOCK_MS); return "account_locked_new"; }
      if (locked(ak)) return "account_locked";
      if (s >= SENDER_MAX) { demoLocks.set(sk, t + LOCK_MS); return "sender_locked"; }
      return "recorded";
    },
    async alertOps(p) {
      console.warn("comm_link_code_account_locked (demo)", { orgId: p.orgId, accountKey: p.accountKey });
    },
  };
}

let backendOverride: LinkCodeGuardBackend | "none" | null = null;
export function __setLineLinkCodeGuardBackendForTests(b: LinkCodeGuardBackend | "none" | null): void {
  backendOverride = b;
  if (b === null) { demoFailures.clear(); demoLocks.clear(); }
}

async function guardBackend(): Promise<LinkCodeGuardBackend | null> {
  if (backendOverride === "none") return null;
  if (backendOverride) return backendOverride;
  if (isDemoMode()) return demoBackend();
  return supabaseLinkCodeGuardBackend();
}

const UNAVAILABLE: LinkCodeGuardBackend = {
  async gate() { throw new Error("link_code_guard_unavailable"); },
  async recordFailure() { throw new Error("link_code_guard_unavailable"); },
  async alertOps() {},
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
