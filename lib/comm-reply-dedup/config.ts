/**
 * Duplicate-reply prevention for conversation tools (comm.reply / comm.send /
 * slack.post / slack.post_external). Flag: COMM_REPLY_DEDUP_ENABLED (default OFF,
 * lib/feature-flags.ts). Settings are env-tunable within safe bounds.
 */
import { createHmac } from "node:crypto";
import { isDemoMode } from "@/lib/mode";

export type CommReplyDedupMode = "exact" | "similar";

export type CommReplyDedupSettings = {
  /** Same conversation + same body within this window is not sent again. */
  windowMinutes: number;
  /** exact = normalized body hash only; similar = also keyed MinHash ≥ threshold. */
  mode: CommReplyDedupMode;
  similarityThreshold: number;
  /** Bodies shorter than this (after normalization) are compared exactly only. */
  minSimilarityChars: number;
  /** Pending conversation approvals expire after this. */
  approvalTtlMinutes: number;
};

export const COMM_REPLY_DEDUP_DEFAULTS: CommReplyDedupSettings = {
  windowMinutes: 30,
  mode: "similar",
  similarityThreshold: 0.6,
  minSimilarityChars: 20,
  approvalTtlMinutes: 1440,
};

function boundedNumber(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number((raw ?? "").trim());
  if (!(raw ?? "").trim() || !Number.isFinite(value) || value < min) return fallback;
  return Math.min(value, max);
}

export function commReplyDedupSettings(): CommReplyDedupSettings {
  const d = COMM_REPLY_DEDUP_DEFAULTS;
  const mode = (process.env.COMM_REPLY_DEDUP_MODE ?? "").trim().toLowerCase();
  return {
    windowMinutes: Math.floor(boundedNumber(process.env.COMM_REPLY_DEDUP_WINDOW_MINUTES, 1, 1440, d.windowMinutes)),
    mode: mode === "exact" || mode === "similar" ? mode : d.mode,
    // Below 0.5 would start catching merely related messages: not allowed.
    similarityThreshold: boundedNumber(process.env.COMM_REPLY_DEDUP_SIMILARITY, 0.5, 1, d.similarityThreshold),
    minSimilarityChars: d.minSimilarityChars,
    approvalTtlMinutes: Math.floor(boundedNumber(process.env.COMM_REPLY_APPROVAL_TTL_MINUTES, 5, 7 * 1440, d.approvalTtlMinutes)),
  };
}

/** Ledger rows are kept at least this long (supersede look-back = approval TTL). */
export function commReplyLedgerRetentionSeconds(settings: CommReplyDedupSettings): number {
  return Math.max(settings.windowMinutes, settings.approvalTtlMinutes) * 60 + 3600;
}

const DEMO_KEY = "staffpass-demo-only-comm-reply-dedup-key-v1";
const DERIVE_LABEL = "staffpass:comm-reply-dedup:v1";

/**
 * HMAC key for body / conversation fingerprints (never stored).
 * 1. COMM_REPLY_DEDUP_HMAC_KEY (≥ 32 chars)
 * 2. derived from NOTIFICATION_CONFIG_ENCRYPTION_KEY (already required in
 *    production), domain-separated so the raw key is never used directly
 * 3. demo mode only: a fixed dev key
 * null = not configured → callers fail closed (nothing is sent).
 */
export function resolveCommReplyDedupKey(): Buffer | null {
  const explicit = (process.env.COMM_REPLY_DEDUP_HMAC_KEY ?? "").trim();
  if (explicit.length >= 32) return createHmac("sha256", explicit).update(DERIVE_LABEL).digest();
  const notify = (process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY ?? "").trim();
  if (notify.length >= 32) return createHmac("sha256", notify).update(`${DERIVE_LABEL}:derived`).digest();
  if (isDemoMode()) return createHmac("sha256", DEMO_KEY).update(DERIVE_LABEL).digest();
  return null;
}

let clockForTests: (() => number) | null = null;
/** Tests only: move the dedup clock (window / expiry) without sleeping. */
export function setCommReplyDedupClockForTests(fn: (() => number) | null): void {
  clockForTests = fn;
}
export function commReplyDedupNow(): number {
  return clockForTests ? clockForTests() : Date.now();
}
