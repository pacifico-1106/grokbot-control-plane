/**
 * Shared HTTP helpers for the OAuth authorization endpoints.
 * - Security headers for every browser-facing OAuth page (no framing, no
 *   caching, no referrer leakage of rid / code).
 * - Error page used BEFORE the client + redirect_uri are verified (we never
 *   redirect to an unverified URI).
 * - Redirect builder that always carries `iss` (RFC 9207).
 */
import { oauthIssuer } from "@/lib/mcp-oauth/config";

export const OAUTH_PAGE_SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'self' https: http://localhost:* http://127.0.0.1:*",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Plain HTML error page. `error` is an OAuth error code; text is static (never echoes request input). */
export function oauthErrorPage(status: number, error: string, messageJa: string): Response {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Staffpass 認可エラー</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">接続を続けられません</h1><p>${escapeHtml(messageJa)}</p><p style="color:#666;font-size:.875rem">error: ${escapeHtml(error)}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...OAUTH_PAGE_SECURITY_HEADERS },
  });
}

/** Append OAuth response params (and `iss`) to a VERIFIED redirect_uri, keeping its own query. */
export function buildClientRedirect(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") u.searchParams.set(k, v);
  }
  u.searchParams.set("iss", oauthIssuer());
  return u.toString();
}

export function redirect303(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, ...OAUTH_PAGE_SECURITY_HEADERS, ...extraHeaders },
  });
}

/**
 * Same-origin check for state-changing browser POSTs (consent, login).
 * - `Sec-Fetch-Site`, when present, must be `same-origin`.
 * - `Origin` must be present and equal to the request origin or the issuer origin.
 */
export function isSameOriginBrowserPost(req: Request, opts: { requireOrigin: boolean }): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  if (!origin) return !opts.requireOrigin;
  if (origin === "null") return false;
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(req.url).origin);
  } catch {
    /* ignore */
  }
  try {
    allowed.add(new URL(oauthIssuer()).origin);
  } catch {
    /* ignore */
  }
  return allowed.has(origin);
}
