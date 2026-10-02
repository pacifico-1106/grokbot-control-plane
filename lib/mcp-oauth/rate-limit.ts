/**
 * DB-backed fixed-window rate limits for OAuth endpoints (design §11).
 * Buckets use an HMAC of the client IP (IP_HASH_KEY); no key → fail closed.
 */
import { createHmac } from "node:crypto";
import { ipAddress } from "@vercel/functions";
import { getOAuthStore } from "@/lib/data/oauth";

/**
 * Platform-observed client IP (hardening 7): `ipAddress(req)` from
 * @vercel/functions (Vercel sets x-real-ip from the TCP peer), falling back to
 * x-real-ip. The generic X-Forwarded-For header is never read, so a client
 * cannot pick its own bucket even if a proxy in front appends to XFF.
 */
export function clientIp(req: Request): string {
  const ip = (ipAddress(req) || req.headers.get("x-real-ip") || "").trim();
  return ip || "unknown";
}

/** null when IP_HASH_KEY is missing/short → callers answer 503 (fail-closed). */
export function ipHash(req: Request): string | null {
  const key = process.env.IP_HASH_KEY || "";
  if (key.length < 16) return null;
  return createHmac("sha256", key).update(clientIp(req)).digest("hex").slice(0, 32);
}

export type RateDecision = { allowed: boolean; count: number; retryAfterSec: number };

export async function rateLimit(bucket: string, limit: number, windowSec: number, now = new Date()): Promise<RateDecision> {
  const windowMs = windowSec * 1000;
  const start = Math.floor(now.getTime() / windowMs) * windowMs;
  const count = await getOAuthStore().rateLimitHit(bucket, new Date(start).toISOString());
  return { allowed: count <= limit, count, retryAfterSec: Math.ceil((start + windowMs - now.getTime()) / 1000) };
}

export const OAUTH_RATE_LIMITS = {
  authorizePerIpPerMin: 30,
  tokenPerClientIpPerMin: 60,
  consentPerUserPerMin: 10,
  dcrPerIpPerHour: 10,
  dcrGlobalPerDay: 500,
} as const;
