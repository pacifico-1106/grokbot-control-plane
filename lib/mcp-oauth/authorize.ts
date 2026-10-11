/**
 * GET /oauth/authorize (design §5.1, PR-5).
 *
 * Validation order:
 *  ① client (CIMD / DCR-if-enabled)  ② redirect_uri (client-registered AND server allowlist)
 *     → failures here render an error page and NEVER redirect.
 *  ③ response_type=code  ④ PKCE S256 only  ⑤ resource ∈ allowed  ⑥ scope normalized
 *     → failures here redirect with error + state + iss.
 * Success: store the request (10 min) and 303 to /oauth/consent?rid=<opaque>.
 * No secret ever travels in this URL (code_challenge is public).
 */
import { getOAuthStore, type OAuthStore } from "@/lib/data/oauth";
import { lookupOAuthClient, type ClientLookup } from "@/lib/mcp-oauth/clients";
import {
  AUTH_REQUEST_TTL_SEC,
  OAUTH_SCOPE_EMPLOYEE,
  OAUTH_SCOPE_OFFLINE,
  allowedOAuthResources,
  oauthIssuer,
  oauthMcpResource,
} from "@/lib/mcp-oauth/config";
import { isRedirectAllowedForClient } from "@/lib/mcp-oauth/redirect-policy";
import { randomToken } from "@/lib/mcp-oauth/tokens";

export type AuthorizeOutcome =
  | { type: "page"; status: number; error: string; messageJa: string }
  | { type: "redirect"; location: string; rid?: string };

export type AuthorizeDeps = {
  store?: OAuthStore;
  lookupClient?: (clientId: string) => Promise<ClientLookup>;
  now?: () => Date;
};

const SINGLE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "scope",
  "state",
];

const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_STATE = 1024;

export function normalizeScope(raw: string | null): string[] {
  // Unknown scopes are ignored; the employee scope is always present.
  // offline_access is always granted (refresh rotation is how clients stay connected).
  void raw;
  return [OAUTH_SCOPE_EMPLOYEE, OAUTH_SCOPE_OFFLINE];
}

function errorRedirect(redirectUri: string, error: string, description: string, state: string | null): AuthorizeOutcome {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", oauthIssuer());
  return { type: "redirect", location: u.toString() };
}

export async function handleAuthorizeRequest(url: URL, deps: AuthorizeDeps = {}): Promise<AuthorizeOutcome> {
  const store = deps.store ?? getOAuthStore();
  const now = (deps.now ?? (() => new Date()))();
  const q = url.searchParams;

  const clientId = q.get("client_id") || "";
  const redirectUri = q.get("redirect_uri") || "";
  if (q.getAll("client_id").length > 1 || q.getAll("redirect_uri").length > 1) {
    return { type: "page", status: 400, error: "invalid_request", messageJa: "リクエストのパラメータが重複しています。" };
  }
  if (!clientId) {
    return { type: "page", status: 400, error: "invalid_request", messageJa: "client_id がありません。" };
  }

  // ① client
  const lookup = await (deps.lookupClient ?? ((id: string) => lookupOAuthClient(id)))(clientId);
  if (!lookup.ok) {
    return { type: "page", status: 400, error: "invalid_client", messageJa: "この AI クライアントは確認できませんでした。" };
  }
  if (lookup.client.status !== "active") {
    return { type: "page", status: 400, error: "invalid_client", messageJa: "この AI クライアントは利用できません。" };
  }

  // ② redirect_uri (exact registered + server allowlist; loopback port only is flexible)
  if (!redirectUri || !isRedirectAllowedForClient(redirectUri, lookup.client.redirectUris)) {
    return { type: "page", status: 400, error: "invalid_redirect_uri", messageJa: "戻り先 URL が許可されていません。" };
  }

  // From here on, errors go back to the verified redirect_uri.
  const stateRaw = q.get("state");
  const state = stateRaw && stateRaw.length <= MAX_STATE ? stateRaw : null;
  if (stateRaw && stateRaw.length > MAX_STATE) {
    return errorRedirect(redirectUri, "invalid_request", "state too long", null);
  }
  for (const p of SINGLE_PARAMS) {
    if (q.getAll(p).length > 1) return errorRedirect(redirectUri, "invalid_request", `duplicate parameter: ${p}`, state);
  }

  // ③
  if (q.get("response_type") !== "code") {
    return errorRedirect(redirectUri, "unsupported_response_type", "response_type must be code", state);
  }
  // ④
  const challenge = q.get("code_challenge") || "";
  if (q.get("code_challenge_method") !== "S256" || !CODE_CHALLENGE_RE.test(challenge)) {
    return errorRedirect(redirectUri, "invalid_request", "PKCE with code_challenge_method=S256 is required", state);
  }
  // ⑤ resource (RFC 8707). Missing → canonical MCP resource (our only resource).
  const resource = (q.get("resource") || oauthMcpResource()).replace(/\/+$/, "");
  if (!allowedOAuthResources().includes(resource)) {
    return errorRedirect(redirectUri, "invalid_target", "resource is not served by this authorization server", state);
  }
  // ⑥
  const scope = normalizeScope(q.get("scope"));

  const rid = randomToken(32);
  await store.createAuthRequest({
    id: rid,
    clientId: lookup.client.clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
    resource,
    scope,
    expiresAt: new Date(now.getTime() + AUTH_REQUEST_TTL_SEC * 1000).toISOString(),
  });

  const consent = new URL("/oauth/consent", oauthIssuer());
  consent.searchParams.set("rid", rid);
  return { type: "redirect", location: consent.toString(), rid };
}
