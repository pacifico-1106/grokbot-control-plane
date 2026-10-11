/**
 * 社員証 lifetime (八坂さん 2026-10-12 02:33, via 木村): every badge gets a
 * 90-day expiry. New issue defaults to 90 days (explicit 1–365 still allowed);
 * rotate — dashboard rotate and the admin MCP reissue pickup — sets
 * expires_at = now + 90 days. Existing credentials without an expiry are left
 * as they are (no backfill); they get one the next time they are rotated.
 */
export const EMPLOYEE_CREDENTIAL_TTL_DAYS = 90;
export const EMPLOYEE_CREDENTIAL_MAX_DAYS = 365;
const DAY_MS = 86_400_000;

/** Issue-time days: missing / 0 / not a number → 90; else clamped to 1–365 (same clamp as before). */
export function issueExpiryDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return EMPLOYEE_CREDENTIAL_TTL_DAYS;
  return Math.min(EMPLOYEE_CREDENTIAL_MAX_DAYS, Math.max(1, Math.trunc(n)));
}

export function credentialExpiresAtFromNow(now: Date = new Date(), days: number = EMPLOYEE_CREDENTIAL_TTL_DAYS): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}
