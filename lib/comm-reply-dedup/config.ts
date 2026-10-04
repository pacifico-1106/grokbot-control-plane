/**
 * Duplicate-reply prevention for conversation tools (comm.reply / comm.send /
 * slack.post / slack.post_external). Flag: COMM_REPLY_DEDUP_ENABLED (default OFF).
 * STUB (TDD red phase).
 */
export type CommReplyDedupMode = "exact" | "similar";

export type CommReplyDedupSettings = {
  windowMinutes: number;
  mode: CommReplyDedupMode;
  similarityThreshold: number;
  minSimilarityChars: number;
  approvalTtlMinutes: number;
};

export const COMM_REPLY_DEDUP_DEFAULTS: CommReplyDedupSettings = {
  windowMinutes: 30,
  mode: "similar",
  similarityThreshold: 0.6,
  minSimilarityChars: 20,
  approvalTtlMinutes: 1440,
};

export function commReplyDedupSettings(): CommReplyDedupSettings {
  return { ...COMM_REPLY_DEDUP_DEFAULTS };
}

/** HMAC key for fingerprints. null = not configured (production fails closed). */
export function resolveCommReplyDedupKey(): Buffer | null {
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
