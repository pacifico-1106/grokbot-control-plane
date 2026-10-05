/**
 * Duplicate-reply prevention for conversation tools (comm.reply / comm.send /
 * slack.post / slack.post_external). Flag: COMM_REPLY_DEDUP_ENABLED (default OFF,
 * lib/feature-flags.ts). Settings are env-tunable within safe bounds.
 */
import { createHmac } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { isDuplicateGuardV2Enabled } from "@/lib/feature-flags";

export type CommReplyDedupMode = "exact" | "similar";
/** Another employee posted the same content to the same conversation. */
export type CrossEmployeeDecision = "warn" | "block";

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
  /** DUPLICATE_GUARD_V2_ENABLED: the rules below apply. */
  v2: boolean;
  /** v2 short bodies (< minSimilarityChars): exact only, same thread, this window. */
  shortWindowMinutes: number;
  /** v2: compare a top-level post and a thread post in the same channel. */
  crossThread: boolean;
  /** v1 warns; v2 blocks by default (COMM_REPLY_DEDUP_CROSS_EMPLOYEE=warn). */
  crossEmployee: CrossEmployeeDecision;
  /** v2: same jobId + same body → once, as long as the ledger keeps the row. */
  jobRetentionDays: number;
};

export const COMM_REPLY_DEDUP_DEFAULTS: CommReplyDedupSettings = {
  windowMinutes: 30,
  mode: "similar",
  similarityThreshold: 0.6,
  minSimilarityChars: 20,
  approvalTtlMinutes: 1440,
  v2: false,
  shortWindowMinutes: 30,
  crossThread: false,
  crossEmployee: "warn",
  jobRetentionDays: 0,
};

/**
 * v2 defaults (Yasaka / 木村 2026-10-05). Why these numbers:
 * - 6 h: the held-approval incident gap was 18 min and v1's 30 min let a
 *   resend at 31 min through; a working day's repeat of a long message to the
 *   same conversation is not a new message. Daily posts (24 h apart) still go.
 * - 2 min for short bodies: an identical "OK" / "了解です" to the same thread
 *   within 2 min is a retry or a loop, a few minutes apart it is a new reply.
 * - 30 days job retention: "regardless of time" bounded by the ledger
 *   retention (the RPC refuses more than 30 days).
 */
export const DUPLICATE_GUARD_V2_DEFAULTS = {
  windowMinutes: 360,
  shortWindowMinutes: 2,
  crossEmployee: "block" as CrossEmployeeDecision,
  jobRetentionDays: 30,
};

function boundedNumber(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number((raw ?? "").trim());
  if (!(raw ?? "").trim() || !Number.isFinite(value) || value < min) return fallback;
  return Math.min(value, max);
}

export function commReplyDedupSettings(): CommReplyDedupSettings {
  const d = COMM_REPLY_DEDUP_DEFAULTS;
  const v2 = isDuplicateGuardV2Enabled();
  const mode = (process.env.COMM_REPLY_DEDUP_MODE ?? "").trim().toLowerCase();
  const cross = (process.env.COMM_REPLY_DEDUP_CROSS_EMPLOYEE ?? "").trim().toLowerCase();
  const windowDefault = v2 ? DUPLICATE_GUARD_V2_DEFAULTS.windowMinutes : d.windowMinutes;
  return {
    windowMinutes: Math.floor(boundedNumber(process.env.COMM_REPLY_DEDUP_WINDOW_MINUTES, 1, 1440, windowDefault)),
    mode: mode === "exact" || mode === "similar" ? mode : d.mode,
    // Below 0.5 would start catching merely related messages: not allowed.
    similarityThreshold: boundedNumber(process.env.COMM_REPLY_DEDUP_SIMILARITY, 0.5, 1, d.similarityThreshold),
    minSimilarityChars: d.minSimilarityChars,
    approvalTtlMinutes: Math.floor(boundedNumber(process.env.COMM_REPLY_APPROVAL_TTL_MINUTES, 5, 7 * 1440, d.approvalTtlMinutes)),
    v2,
    shortWindowMinutes: v2
      ? Math.floor(boundedNumber(process.env.COMM_REPLY_DEDUP_SHORT_WINDOW_MINUTES, 1, 60, DUPLICATE_GUARD_V2_DEFAULTS.shortWindowMinutes))
      : d.shortWindowMinutes,
    crossThread: v2,
    // v1: warning only (it never blocks). v2: block unless explicitly "warn";
    // anything else (incl. "off") keeps the default — warning is the minimum.
    crossEmployee: v2 ? (cross === "warn" ? "warn" : DUPLICATE_GUARD_V2_DEFAULTS.crossEmployee) : "warn",
    jobRetentionDays: v2
      ? Math.floor(boundedNumber(process.env.COMM_REPLY_DEDUP_JOB_RETENTION_DAYS, 1, 30, DUPLICATE_GUARD_V2_DEFAULTS.jobRetentionDays))
      : 0,
  };
}

/** Ledger rows are kept at least this long (supersede look-back = approval TTL). */
export function commReplyLedgerRetentionSeconds(
  settings: Pick<CommReplyDedupSettings, "windowMinutes" | "approvalTtlMinutes"> & Partial<Pick<CommReplyDedupSettings, "jobRetentionDays">>
): number {
  const base = Math.max(settings.windowMinutes, settings.approvalTtlMinutes) * 60 + 3600;
  // v2: job keys are kept for jobRetentionDays (the RPC caps retention at 30 days).
  return Math.min(Math.max(base, (settings.jobRetentionDays ?? 0) * 86400), 30 * 86400);
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
