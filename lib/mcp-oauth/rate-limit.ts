/**
 * DB-backed fixed-window rate limits for OAuth endpoints (design §11).
 * Buckets use an HMAC of the client IP (IP_HASH_KEY); no key → fail closed.
 */
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
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

/** 8 × 16-bit words of an IPv6 address (any spelling, optional %zone / trailing dotted quad), or null. */
function ipv6Words(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const o = last.split(".").map(Number);
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, lastColon) + (s.slice(0, lastColon).endsWith(":") ? ":" : "");
  }
  const [head, rest] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":").filter((x) => x !== "") : [];
  const r = rest ? rest.split(":").filter((x) => x !== "") : [];
  const fill = 8 - tail.length - h.length - r.length;
  if (fill < 0 || (rest === null && fill !== 0)) return null;
  return [...h, ...new Array<string>(fill).fill("0"), ...r].map((g) => parseInt(g, 16)).concat(tail);
}

/**
 * Rate-limit identity of a client address (#318 follow-up): an IPv6 client
 * is its /64 (one end-site / SLAAC subnet hands a single host 2^64
 * addresses), IPv4 and IPv4-mapped IPv6 are the IPv4 address. Anything else
 * collapses into one "unknown" bucket.
 */
export function ipRateKey(raw: string): string {
  const ip = String(raw ?? "").trim().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) return ip;
  const w = ipv6Words(ip);
  if (!w) return "unknown";
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) {
    return [w[6] >> 8, w[6] & 0xff, w[7] >> 8, w[7] & 0xff].join(".");
  }
  return `${w.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/**
 * HMAC of ipRateKey(clientIp) — used by every OAuth IP bucket (authorize,
 * token, revoke, DCR) and stored as created_ip_hash.
 * null when IP_HASH_KEY is missing/short → callers answer 503 (fail-closed).
 */
export function ipHash(req: Request): string | null {
  const key = process.env.IP_HASH_KEY || "";
  if (key.length < 16) return null;
  return createHmac("sha256", key).update(ipRateKey(clientIp(req))).digest("hex").slice(0, 32);
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
  /** IP-only (per /64 for IPv6), checked before the client lookup (#318 follow-up). */
  tokenPerIpPerMin: 300,
  revokePerIpPerMin: 120,
  consentPerUserPerMin: 10,
  dcrPerIpPerHour: 10,
  dcrGlobalPerDay: 500,
} as const;

/** Unconsented DCR clients older than this are deleted by the daily oauth-purge cron. */
export const DCR_STALE_CLIENT_AFTER_SEC = 86400;
