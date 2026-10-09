/**
 * Thread single-flight settings (THREAD_SINGLE_FLIGHT_ENABLED, default OFF).
 * Lease TTL: long enough to cover one conversation post (chat.postMessage has a
 * 5 s timeout and may be retried once through conversations.open), short
 * enough that a crashed sender blocks the thread for at most one TTL.
 */
export const THREAD_LEASE_TTL_DEFAULT_SECONDS = 60;
export const THREAD_LEASE_TTL_MIN_SECONDS = 15;
export const THREAD_LEASE_TTL_MAX_SECONDS = 300;
/** A read point further than this in the future is ignored (clock skew allowance). */
export const READ_THROUGH_FUTURE_SKEW_SECONDS = 120;

export function threadLeaseTtlSeconds(): number {
  const raw = Number((process.env.THREAD_SINGLE_FLIGHT_LEASE_TTL_SECONDS ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return THREAD_LEASE_TTL_DEFAULT_SECONDS;
  return Math.min(THREAD_LEASE_TTL_MAX_SECONDS, Math.max(THREAD_LEASE_TTL_MIN_SECONDS, Math.floor(raw)));
}

let clockForTests: (() => number) | null = null;
/** Tests only: move the guard clock (lease expiry) without sleeping. */
export function setThreadGuardClockForTests(fn: (() => number) | null): void {
  clockForTests = fn;
}
export function threadGuardNow(): number {
  return clockForTests ? clockForTests() : Date.now();
}
