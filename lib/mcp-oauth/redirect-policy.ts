/**
 * redirect_uri policy (design §5.4, S2). Exact string match against the
 * allowlist; the only wildcards are `{callback_id}` ([A-Za-z0-9_-]{1,128})
 * and `{port}` for http loopback (RFC 8252 §7.3). The raw string must already
 * be in canonical form (=== URL.href) so case / encoding / dot-segment /
 * userinfo / default-port tricks never match.
 */
import { redirectAllowlist } from "@/lib/mcp-oauth/config";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * The ONLY non-http(s) redirect URIs that can ever pass (Cursor desktop,
 * 2026-10-10). Fixed in code, compared as whole strings: an operator
 * MCP_OAUTH_REDIRECT_ALLOWLIST entry cannot add another custom scheme, and no
 * placeholder / case / path / query variant matches. A custom scheme can be
 * claimed by any local app; PKCE S256 (required for every authorize) is what
 * keeps an intercepted code useless.
 */
export const EXACT_CUSTOM_SCHEME_REDIRECTS: readonly string[] = ["cursor://anysphere.cursor-mcp/oauth/callback"];

function canonical(uri: string): URL | null {
  if (typeof uri !== "string" || uri.length > 2048) return null;
  if (/[\s\\]/.test(uri) || uri.includes("%")) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.href !== uri) return null;
  if (u.username || u.password || u.hash || u.search) return null;
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return EXACT_CUSTOM_SCHEME_REDIRECTS.includes(uri) ? u : null;
  }
  if (u.protocol === "http:" && !LOOPBACK_HOSTS.has(u.hostname)) return null;
  return u;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function patternToRegex(pattern: string): RegExp {
  const parts = pattern.split(/(\{callback_id\}|\{port\})/);
  const body = parts
    .map((p) => (p === "{callback_id}" ? "[A-Za-z0-9_-]{1,128}" : p === "{port}" ? "(?:[1-9][0-9]{0,4})" : escapeRe(p)))
    .join("");
  return new RegExp(`^${body}$`);
}

export function matchesRedirectAllowlist(uri: string, allowlist: string[] = redirectAllowlist()): boolean {
  const u = canonical(uri);
  if (!u) return false;
  if (u.port && Number(u.port) > 65535) return false;
  if (u.protocol !== "https:" && u.protocol !== "http:") return allowlist.includes(uri); // exact string only
  return allowlist.some((p) => patternToRegex(p).test(uri));
}

/**
 * A request's redirect_uri must be registered by the client (exact) AND pass
 * the server allowlist. Called before ANY redirect is issued.
 */
export function isRedirectAllowedForClient(uri: string, registered: string[]): boolean {
  if (!matchesRedirectAllowlist(uri)) return false;
  if (registered.includes(uri)) return true;
  // RFC 8252 §7.3: loopback port is chosen at runtime — match ignoring port only.
  const u = canonical(uri);
  if (!u || !isLoopbackRedirect(uri)) return false;
  return registered.some((r) => {
    const ru = canonical(r);
    return Boolean(ru && isLoopbackRedirect(r) && ru.hostname === u.hostname && ru.pathname === u.pathname);
  });
}

export function isLoopbackRedirect(uri: string): boolean {
  const u = canonical(uri);
  return Boolean(u && u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname));
}

export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}
