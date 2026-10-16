/**
 * App-side login attempt caps. Enforced only when LOGIN_RATE_LIMIT_ENABLED is ON.
 * Keyed HMAC(IP)+HMAC(account) plus a per-IP spray cap; no account-only bucket.
 */
export const LOGIN_RATE_LIMITS = {
  perIp: 20,
  perIpWindowMs: 15 * 60_000,
  perIpAccount: 10,
  perIpAccountWindowMs: 15 * 60_000,
} as const;
