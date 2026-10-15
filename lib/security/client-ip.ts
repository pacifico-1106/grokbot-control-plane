/**
 * Platform-observed client IP for rate limits and Turnstile remoteip.
 *
 * This app runs on Vercel and is not behind Cloudflare. `cf-connecting-ip` is
 * therefore attacker-controlled and must never be read. Prefer headers Vercel
 * sets from the TCP peer (`x-vercel-forwarded-for`, `x-real-ip`). Generic
 * `X-Forwarded-For` is a last resort for non-Vercel runtimes and is spoofable
 * if a proxy is missing.
 *
 * OAuth buckets use `@vercel/functions` `ipAddress` instead (never XFF).
 */

export type HeaderReader = { get(name: string): string | null };

export function trustedClientIpFromHeaders(headers: HeaderReader): string | null {
  const vercel = headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  if (vercel) return vercel;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || null;
}

export function trustedClientIp(req: { headers: HeaderReader }): string | null {
  return trustedClientIpFromHeaders(req.headers);
}
