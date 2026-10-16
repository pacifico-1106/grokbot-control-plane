/**
 * Platform-observed client IP for rate limits and Turnstile remoteip.
 *
 * This app runs on Vercel and is not behind Cloudflare. `cf-connecting-ip` is
 * therefore attacker-controlled and must never be read. Prefer headers Vercel
 * sets from the TCP peer (`x-vercel-forwarded-for`, `x-real-ip`). Generic
 * `X-Forwarded-For` is a last resort for non-Vercel runtimes: only the
 * rightmost hop is used (the address the immediate proxy observed). The
 * leftmost hop is client-spoofable and must not change the rate-limit key.
 *
 * OAuth buckets use `@vercel/functions` `ipAddress` instead (never XFF).
 */

export type HeaderReader = { get(name: string): string | null };

function firstHop(value: string | null): string | null {
  const hop = value?.split(",")[0]?.trim();
  return hop || null;
}

function lastHop(value: string | null): string | null {
  if (!value) return null;
  const hops = value.split(",").map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : null;
}

export function trustedClientIpFromHeaders(headers: HeaderReader): string | null {
  const vercel = firstHop(headers.get("x-vercel-forwarded-for"));
  if (vercel) return vercel;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  return lastHop(headers.get("x-forwarded-for"));
}

export function trustedClientIp(req: { headers: HeaderReader }): string | null {
  return trustedClientIpFromHeaders(req.headers);
}
