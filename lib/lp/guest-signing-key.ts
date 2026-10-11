/**
 * GUEST_SIGNING_KEY is required for LP guest sessions (fail closed, no dev fallback).
 *
 * Same pattern as SETUP_LINK_SIGNING_SECRET (lib/security/setup-links.ts): a missing, blank or
 * placeholder key throws GuestSigningKeyMissingError; callers turn that into a clear 503 instead of
 * signing with a guessable key. Kept in its own module so routes can recognise the error without
 * importing lib/lp/journeys (which tests mock).
 */

export const GUEST_SIGNING_KEY_ENV = "GUEST_SIGNING_KEY";
export const GUEST_SIGNING_KEY_MISSING_CODE = "guest_signing_key_missing";

/** Error code + message the guest routes return when signing is unavailable. */
export const GUEST_SESSIONS_UNAVAILABLE = {
  error: "guest_sessions_unavailable",
  message: "チャット機能は現在利用できません（設定を確認中です）。時間をおいてお試しください。",
} as const;

export class GuestSigningKeyMissingError extends Error {
  readonly code = GUEST_SIGNING_KEY_MISSING_CODE;
  constructor() {
    super(`${GUEST_SIGNING_KEY_ENV} is not configured; LP guest sessions are disabled (fail closed).`);
    this.name = "GuestSigningKeyMissingError";
  }
}

export function isGuestSigningKeyMissingError(err: unknown): boolean {
  return (
    err instanceof GuestSigningKeyMissingError ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === GUEST_SIGNING_KEY_MISSING_CODE)
  );
}

/** Returns the configured key or throws GuestSigningKeyMissingError. Never returns a fallback. */
export function requireGuestSigningKey(): string {
  const key = process.env[GUEST_SIGNING_KEY_ENV];
  if (!key || !key.trim() || key.startsWith("replace_me")) {
    throw new GuestSigningKeyMissingError();
  }
  return key;
}
