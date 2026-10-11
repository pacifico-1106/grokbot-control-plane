/**
 * Login `next` validation (shared by /api/auth/login, /login and redirects to
 * /login). Only a same-origin path survives; anything else → "/app". Never an
 * open redirect: other origins, protocol-relative (//x, /\x), javascript: /
 * data: and other schemes all fall back.
 */
const FALLBACK = "/app";
/** Base used when there is no request URL: only relative paths can match it. */
const OPAQUE_BASE = "https://next.invalid";

export function safeNextDestination(value: string, requestUrl: string): string {
  if (typeof value !== "string" || !value.trim()) return FALLBACK;
  try {
    const base = new URL(requestUrl);
    const candidate = new URL(value, base);
    if (candidate.origin !== base.origin) return FALLBACK;
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return FALLBACK;
  }
}

/** For server components without a request URL (e.g. /login): relative same-site paths only. */
export function safeNextPath(value: string | null | undefined): string {
  if (typeof value !== "string" || !value) return FALLBACK;
  return safeNextDestination(value, OPAQUE_BASE);
}

/** `/login?next=<validated path>` on the request's origin. */
export function loginRedirectUrl(nextPath: string, requestUrl: string): URL {
  const url = new URL("/login", requestUrl);
  url.searchParams.set("next", safeNextDestination(nextPath, requestUrl));
  return url;
}
