/**
 * Single source of truth for the public, absolute app origin used in emails,
 * approval poll URLs, Stripe return URLs, OAuth callbacks and Supabase Auth
 * redirectTo values.
 *
 * Fail-safe rule: on a Vercel production deploy we NEVER return a loopback or
 * non-https origin, even if NEXT_PUBLIC_APP_URL is missing or mis-set
 * (e.g. copied from .env.example as http://localhost:3000). Production always
 * resolves to an https, non-loopback origin — the canonical Staffpass host
 * unless an explicit https override is configured.
 */

/** Canonical public Staffpass host. */
export const STAFFPASS_PUBLIC_ORIGIN = "https://staffpass.sealith.com";

type Env = Record<string, string | undefined>;

function normalizeOrigin(raw: string | undefined | null): string | null {
  const v = (raw || "").trim().replace(/\/+$/, "");
  if (!v) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h === "::" ||
    /^127\./.test(h)
  );
}

/** True only for a public https origin (no loopback). */
export function isPublicHttpsOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/** Vercel production deploy (not preview / development / local). */
export function isProductionDeploy(env: Env = process.env): boolean {
  return env.VERCEL_ENV === "production";
}

/**
 * Public app origin (no trailing slash).
 * - VERCEL_ENV=production: NEXT_PUBLIC_APP_URL only if it is public https,
 *   otherwise the canonical host. Never localhost.
 * - NODE_ENV=production elsewhere (preview / self-hosted): configured value,
 *   else canonical host (stable links across ephemeral deploys).
 * - Local dev / test: configured value, VERCEL_URL, else http://localhost:3000.
 */
export function resolveAppOrigin(env: Env = process.env): string {
  const configured = normalizeOrigin(env.NEXT_PUBLIC_APP_URL);

  if (isProductionDeploy(env)) {
    return isPublicHttpsOrigin(configured) ? configured : STAFFPASS_PUBLIC_ORIGIN;
  }
  if (configured) return configured;
  if (env.NODE_ENV === "production") return STAFFPASS_PUBLIC_ORIGIN;

  const prodHost = normalizeOrigin(env.VERCEL_PROJECT_PRODUCTION_URL);
  if (prodHost) {
    const host = new URL(prodHost).hostname;
    if (host.includes("staffpass") || host.includes("sealith")) {
      return `https://${host}`;
    }
    return STAFFPASS_PUBLIC_ORIGIN;
  }
  const vercelUrl = normalizeOrigin(env.VERCEL_URL);
  if (vercelUrl) return `https://${new URL(vercelUrl).host}`;
  return "http://localhost:3000";
}

/**
 * Origin for Supabase Auth email links (redirectTo / redirect_to).
 * Production is pinned to the canonical host so it always matches the
 * Supabase Redirect URLs allowlist (a non-allowlisted redirectTo silently
 * falls back to Site URL — which is how invites ended up on localhost).
 */
export function resolveAuthRedirectOrigin(env: Env = process.env): string {
  if (isProductionDeploy(env)) return STAFFPASS_PUBLIC_ORIGIN;
  return resolveAppOrigin(env);
}

/** `https://staffpass.sealith.com/auth/confirm` in production. */
export function authConfirmUrl(env: Env = process.env): string {
  return `${resolveAuthRedirectOrigin(env)}/auth/confirm`;
}
