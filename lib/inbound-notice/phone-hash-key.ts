/**
 * INBOUND_CALL_NOTICE_PHONE_HASH_KEY — same shape as IP_HASH_KEY
 * (lib/security/ip-hash-key.ts). No fallback. Missing / blank / placeholder
 * throws; callers fail closed and do not hash phones unsalted.
 */

export const INBOUND_CALL_NOTICE_PHONE_HASH_KEY_ENV = "INBOUND_CALL_NOTICE_PHONE_HASH_KEY";
export const PHONE_HASH_KEY_MISSING_CODE = "phone_hash_key_missing";

export class PhoneHashKeyMissingError extends Error {
  readonly code = PHONE_HASH_KEY_MISSING_CODE;
  constructor() {
    super(
      `${INBOUND_CALL_NOTICE_PHONE_HASH_KEY_ENV} is not configured; phone hashing is disabled (fail closed).`
    );
    this.name = "PhoneHashKeyMissingError";
  }
}

export function isPhoneHashKeyMissingError(err: unknown): boolean {
  return (
    err instanceof PhoneHashKeyMissingError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === PHONE_HASH_KEY_MISSING_CODE)
  );
}

function usable(key: string | undefined): key is string {
  if (!key || !key.trim()) return false;
  const lower = key.trim().toLowerCase();
  return !lower.startsWith("replace_me") && lower !== "changeme";
}

export function isPhoneHashKeyConfigured(): boolean {
  return usable(process.env[INBOUND_CALL_NOTICE_PHONE_HASH_KEY_ENV]);
}

/** Returns the configured key or throws. Never returns a fallback. */
export function requirePhoneHashKey(): string {
  const key = process.env[INBOUND_CALL_NOTICE_PHONE_HASH_KEY_ENV];
  if (!usable(key)) throw new PhoneHashKeyMissingError();
  return key;
}
