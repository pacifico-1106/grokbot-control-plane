import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolveAppOrigin } from "../app-url";

/** Opaque status token for signed poll URLs (not a session cookie). */
export function generateStatusToken(): string {
  return `st_${randomBytes(24).toString("base64url")}`;
}

/** Compact, random Telegram callback reference (12 hex chars / 48 bits). */
export function generateTelegramRef(): string {
  return randomBytes(6).toString("hex");
}

export function hashStatusToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function statusTokensEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ha = Buffer.from(hashStatusToken(a), "hex");
  const hb = Buffer.from(hashStatusToken(b), "hex");
  if (ha.length !== hb.length) return false;
  try {
    return timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

export { STAFFPASS_PUBLIC_ORIGIN } from "../app-url";

/**
 * Public app origin for poll URLs (prod / local).
 * Delegates to resolveAppOrigin: never localhost on VERCEL_ENV=production.
 */
export function getAppOrigin(): string {
  return resolveAppOrigin();
}

export function buildPollPath(approvalId: string, statusToken: string): string {
  const q = new URLSearchParams({ id: approvalId, token: statusToken });
  return `/api/approvals/status?${q.toString()}`;
}

export function buildPollUrl(approvalId: string, statusToken: string): string {
  return `${getAppOrigin()}${buildPollPath(approvalId, statusToken)}`;
}
