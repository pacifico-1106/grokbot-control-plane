/**
 * MCP OAuth configuration (env-driven, cheap to change; design §12).
 * Nothing here enables anything by itself — isMcpOAuthEnabled() is the gate.
 */
import { isMcpOAuthDcrFlagOn, isMcpOAuthFlagOn } from "@/lib/feature-flags";
import { isDemoMode } from "@/lib/mode";

export const OAUTH_SCOPE_EMPLOYEE = "staffpass.employee";
export const OAUTH_SCOPE_OFFLINE = "offline_access";
export const ACCESS_TOKEN_PREFIX = "sp_at_";
export const REFRESH_TOKEN_PREFIX = "sp_rt_";

export const ACCESS_TOKEN_TTL_SEC = 3600;
export const REFRESH_TOKEN_TTL_SEC = 30 * 86400;
export const GRANT_MAX_TTL_SEC = 90 * 86400;
export const AUTH_REQUEST_TTL_SEC = 600;
export const AUTH_CODE_TTL_SEC = 60;
/** Concurrent-refresh grace: reuse within this window is NOT treated as theft. */
export const REFRESH_REUSE_GRACE_SEC = 30;
/** Consent requires a sign-in no older than this. */
export const CONSENT_MAX_LOGIN_AGE_SEC = 15 * 60;

/** OAuth is never live in DEMO mode (in-memory data, no real tenants). */
export function isMcpOAuthEnabled(): boolean {
  return isMcpOAuthFlagOn() && !isDemoMode();
}

export function isMcpOAuthDcrEnabled(): boolean {
  return isMcpOAuthEnabled() && isMcpOAuthDcrFlagOn();
}

function csv(v: string | undefined): string[] {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Issuer: no path, no trailing slash. Must equal PRM authorization_servers[0] exactly. */
export function oauthIssuer(): string {
  const raw = (process.env.MCP_OAUTH_ISSUER || "https://staffpass.sealith.com").trim();
  return raw.replace(/\/+$/, "");
}

/** Canonical MCP resource (what users type into Claude / ChatGPT). */
export function oauthMcpResource(): string {
  return `${oauthIssuer()}/api/mcp`;
}

/** Resources the AS will mint tokens for (RFC 8707). Both are usable ONLY at /api/mcp. */
export function allowedOAuthResources(): string[] {
  return [oauthMcpResource(), oauthIssuer()];
}

export function protectedResourceMetadataUrl(): string {
  return `${oauthIssuer()}/.well-known/oauth-protected-resource/api/mcp`;
}

/**
 * Org allowlist for consent + token use (pilot safety valve).
 * Empty = every org. Q5 pilot: set to the TOKYO307 org id only.
 */
export function oauthOrgAllowlist(): string[] {
  return csv(process.env.MCP_OAUTH_ORG_ALLOWLIST);
}

export function isOrgAllowedForOAuth(orgId: string | null | undefined): boolean {
  if (!orgId) return false;
  const list = oauthOrgAllowlist();
  return list.length === 0 || list.includes(orgId);
}

export const DEFAULT_CIMD_ALLOWED_HOSTS = ["chatgpt.com", "claude.ai", "claude.com", "anthropic.com"];

export function cimdAllowedHosts(): string[] {
  const v = csv(process.env.MCP_OAUTH_CIMD_ALLOWED_HOSTS).map((h) => h.toLowerCase());
  return v.length ? v : DEFAULT_CIMD_ALLOWED_HOSTS;
}

/**
 * Redirect allowlist patterns (exact match except: `{callback_id}` segment and
 * loopback `{port}`). Design §5.4.
 */
export const DEFAULT_REDIRECT_ALLOWLIST = [
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/{callback_id}",
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "http://localhost:{port}/callback",
  "http://127.0.0.1:{port}/callback",
];

export function redirectAllowlist(): string[] {
  const v = csv(process.env.MCP_OAUTH_REDIRECT_ALLOWLIST);
  return v.length ? v : DEFAULT_REDIRECT_ALLOWLIST;
}

/** HMAC secret for consent CSRF tokens. ≥32 bytes or OAuth consent fails closed. */
export function oauthStateSecret(): string | null {
  const v = process.env.MCP_OAUTH_STATE_SECRET || "";
  return v.length >= 32 ? v : null;
}
