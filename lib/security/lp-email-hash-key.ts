/**
 * LP_CUSTOMER_EMAIL_HASH_KEY (木村 2026-10-12 on #342): server-only key for the
 * keyed HMAC-SHA256 of the LP payer's email (lp_provisionings.customer_email_hmac).
 * Same handling as IP_HASH_KEY (lib/security/ip-hash-key.ts): required, no dev
 * fallback; missing / blank / placeholder → LpEmailHashKeyMissingError and the
 * caller fails closed (stores nothing). Separate from IP_HASH_KEY so the two can
 * be rotated independently and an IP-hash leak does not open the email hashes.
 */
export const LP_EMAIL_HASH_KEY_ENV = "LP_CUSTOMER_EMAIL_HASH_KEY";
export const LP_EMAIL_HASH_KEY_MISSING_CODE = "lp_email_hash_key_missing";

export class LpEmailHashKeyMissingError extends Error {
  readonly code = LP_EMAIL_HASH_KEY_MISSING_CODE;
  constructor() {
    super(`${LP_EMAIL_HASH_KEY_ENV} is not configured; LP email hashing is disabled (fail closed).`);
    this.name = "LpEmailHashKeyMissingError";
  }
}

function usable(key: string | undefined): key is string {
  if (!key || !key.trim()) return false;
  const lower = key.trim().toLowerCase();
  return !lower.startsWith("replace_me") && lower !== "changeme";
}

export function isLpEmailHashKeyConfigured(): boolean {
  return usable(process.env[LP_EMAIL_HASH_KEY_ENV]);
}

/** Returns the configured key or throws LpEmailHashKeyMissingError. Never returns a fallback. */
export function requireLpEmailHashKey(): string {
  const key = process.env[LP_EMAIL_HASH_KEY_ENV];
  if (!usable(key)) throw new LpEmailHashKeyMissingError();
  return key;
}
