/**
 * IP_HASH_KEY is required (fail closed, no dev fallback) — same shape as GUEST_SIGNING_KEY (#302)
 * and SETUP_LINK_SIGNING_SECRET (#294).
 *
 * The key salts every stored IP / UA / normalized-email hash (LP rate limiting, LP journeys /
 * handoffs / wake webhooks, signup attempt fingerprints). A fixed public fallback makes those
 * hashes reversible by brute force over the IPv4 space, so a missing, blank or placeholder key
 * throws IpHashKeyMissingError and callers answer 503 before writing anything.
 */

export const IP_HASH_KEY_ENV = "IP_HASH_KEY";
export const IP_HASH_KEY_MISSING_CODE = "ip_hash_key_missing";

/** Removed fallback; refused even if someone sets it explicitly. */
const OLD_DEV_DEFAULT = "default_hash_key_for_dev";

/** Error code + message LP routes return when the key is missing. */
export const IP_HASH_UNAVAILABLE = {
  error: "ip_hash_unavailable",
  message: "現在この機能は利用できません（設定を確認中です）。時間をおいてお試しください。",
} as const;

export class IpHashKeyMissingError extends Error {
  readonly code = IP_HASH_KEY_MISSING_CODE;
  constructor() {
    super(`${IP_HASH_KEY_ENV} is not configured; IP / fingerprint hashing is disabled (fail closed).`);
    this.name = "IpHashKeyMissingError";
  }
}

export function isIpHashKeyMissingError(err: unknown): boolean {
  return (
    err instanceof IpHashKeyMissingError ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === IP_HASH_KEY_MISSING_CODE)
  );
}

function usable(key: string | undefined): key is string {
  if (!key || !key.trim()) return false;
  const lower = key.trim().toLowerCase();
  return !lower.startsWith("replace_me") && lower !== "changeme" && key.trim() !== OLD_DEV_DEFAULT;
}

export function isIpHashKeyConfigured(): boolean {
  return usable(process.env[IP_HASH_KEY_ENV]);
}

/** Returns the configured key or throws IpHashKeyMissingError. Never returns a fallback. */
export function requireIpHashKey(): string {
  const key = process.env[IP_HASH_KEY_ENV];
  if (!usable(key)) throw new IpHashKeyMissingError();
  return key;
}
