import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { GOOGLE_CALENDAR_SCOPES } from "./scopes";

export const GOOGLE_OAUTH_COOKIE = "staffpass_google_oauth";
export const GOOGLE_PKCE_COOKIE = "staffpass_google_pkce";
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Check if Google OAuth is configured (client ID and secret present).
 * Fail-closed: if not configured, all Google OAuth routes should return 503.
 */
export function googleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()
  );
}

export function googleOAuthRedirectUrl(): string {
  const explicit = process.env.GOOGLE_OAUTH_REDIRECT_URL?.trim().replace(/\/$/, "");
  if (explicit) return explicit;
  return `${getAppOrigin()}/api/google/oauth/callback`;
}

/**
 * Signing secret for OAuth state HMAC.
 * Priority: GOOGLE_OAUTH_STATE_SECRET > GOOGLE_OAUTH_CLIENT_SECRET.
 * Fail-closed: returns empty string if neither is set.
 */
function signingSecret(): string {
  return (
    process.env.GOOGLE_OAUTH_STATE_SECRET?.trim() ||
    process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ||
    ""
  );
}

export type GoogleOAuthState = {
  orgId: string;
  employeeId: string;
  nonce: string;
  exp: number;
};

/**
 * Generate a cryptographically random PKCE code verifier.
 * 43-128 characters, URL-safe base64.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Generate PKCE code challenge from verifier (S256 method).
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("base64url");
}

/**
 * Sign OAuth state with HMAC for tamper detection.
 * Includes org+employee binding, nonce, and expiry.
 * PKCE code verifier is stored separately in a httpOnly cookie (never in state).
 */
export function signGoogleOAuthState(input: {
  orgId: string;
  employeeId: string;
  nonce: string;
}): string {
  const payload: GoogleOAuthState = {
    orgId: input.orgId,
    employeeId: input.employeeId,
    nonce: input.nonce,
    exp: Date.now() + STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = signingSecret();
  if (!secret) throw new Error("google_oauth_unconfigured");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

/**
 * Verify signed OAuth state. Returns parsed state if valid, null otherwise.
 * Checks signature, expiry, and nonce match.
 */
export function verifyGoogleOAuthState(
  state: string,
  nonce: string
): GoogleOAuthState | null {
  const secret = signingSecret();
  if (!secret || !state || !nonce) return null;
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const encoded = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as GoogleOAuthState;
    if (!parsed?.orgId || !parsed?.employeeId || !parsed?.nonce) return null;
    if (parsed.nonce !== nonce) return null;
    if (!Number.isFinite(parsed.exp) || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build Google OAuth authorization URL.
 * Requests offline access for refresh token, uses PKCE if code challenge provided.
 */
export function googleAuthorizeUrl(
  state: string,
  codeChallenge?: string
): string {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || "";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleOAuthRedirectUrl(),
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens.
 * Returns access_token, refresh_token, id_token, scope, etc.
 */
export async function exchangeGoogleCode(
  code: string,
  codeVerifier?: string
): Promise<GoogleTokenResponse> {
  const body: Record<string, string> = {
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || "",
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || "",
    code,
    redirect_uri: googleOAuthRedirectUrl(),
    grant_type: "authorization_code",
  };
  if (codeVerifier) {
    body.code_verifier = codeVerifier;
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(10_000),
  });
  return (await response.json().catch(() => ({}))) as GoogleTokenResponse;
}

export interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Decode Google ID token (JWT) to extract user info.
 * Does not verify signature — use only after exchanging code with Google.
 */
export function decodeIdToken(idToken: string): GoogleIdTokenPayload | null {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
    return payload as GoogleIdTokenPayload;
  } catch {
    return null;
  }
}

export interface GoogleIdTokenPayload {
  iss?: string;
  azp?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  at_hash?: string;
  name?: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
  locale?: string;
  iat?: number;
  exp?: number;
}

/**
 * Validate ID token claims for security.
 * Checks aud, iss, exp, and email_verified.
 */
export function validateIdToken(payload: GoogleIdTokenPayload): {
  valid: boolean;
  reason?: string;
} {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || "";

  if (!payload.aud || payload.aud !== clientId) {
    return { valid: false, reason: "invalid_audience" };
  }

  const validIssuers = ["accounts.google.com", "https://accounts.google.com"];
  if (!payload.iss || !validIssuers.includes(payload.iss)) {
    return { valid: false, reason: "invalid_issuer" };
  }

  if (!payload.exp || payload.exp * 1000 < Date.now()) {
    return { valid: false, reason: "token_expired" };
  }

  if (payload.email_verified !== true) {
    return { valid: false, reason: "email_not_verified" };
  }

  if (!payload.sub) {
    return { valid: false, reason: "missing_subject" };
  }

  return { valid: true };
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshGoogleToken(
  refreshToken: string
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || "",
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return (await response.json().catch(() => ({}))) as GoogleTokenResponse;
}

/**
 * Revoke a Google token (access or refresh).
 */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(10_000),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}
