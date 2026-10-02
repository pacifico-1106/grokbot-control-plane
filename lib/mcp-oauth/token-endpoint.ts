/**
 * Token + revocation endpoints (design §5.2 / §9, PR-6).
 *
 * POST /api/oauth/token   (application/x-www-form-urlencoded only, public clients, PKCE S256)
 *  - authorization_code: one-time code; reuse → revoke the whole grant + audit.
 *  - refresh_token: rotation on every use. Reuse of an already-rotated token
 *    within REFRESH_REUSE_GRACE_SEC → invalid_grant only (benign retry race);
 *    after that → treat as theft: revoke grant + all tokens, audit, notify owners.
 *  - Lifetimes: access 1h, refresh 30d, both capped by the grant expiry (≤90d, ≤ credential).
 * POST /api/oauth/revoke  (RFC 7009): always 200; revoking a refresh token revokes the grant.
 *
 * Responses carry Cache-Control: no-store. Raw tokens / codes / verifiers never
 * reach logs or audit (hash prefix only).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { getOAuthStore, type OAuthGrantRecord, type OAuthStore } from "@/lib/data/oauth";
import {
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_REUSE_GRACE_SEC,
  REFRESH_TOKEN_TTL_SEC,
  allowedOAuthResources,
  isMcpOAuthDcrEnabled,
  isOrgAllowedForOAuth,
} from "@/lib/mcp-oauth/config";
import type { RateDecision } from "@/lib/mcp-oauth/rate-limit";
import { OAUTH_RATE_LIMITS } from "@/lib/mcp-oauth/rate-limit";
import { hashPrefix, mintAccessToken, mintRefreshToken, sha256Hex } from "@/lib/mcp-oauth/tokens";
import type { AuditEvent } from "@/lib/types";

export const TOKEN_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version",
};

export type SecurityNotice = { orgId: string; employeeId: string; clientHost: string; kind: "refresh_reuse" | "code_reuse" };

export type TokenDeps = {
  store: OAuthStore;
  now: () => Date;
  audit: (e: Omit<AuditEvent, "id" | "createdAt"> & { actorEmail?: string }) => Promise<void>;
  notifySecurity: (n: SecurityNotice) => Promise<void>;
  rateLimit: (bucket: string, limit: number, windowSec: number) => Promise<RateDecision>;
  ipHash: (req: Request) => string | null;
};

type Json = Record<string, unknown>;
export type EndpointResult = { status: number; body: Json | null; headers?: Record<string, string> };

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

function err(status: number, error: string, description: string): EndpointResult {
  return { status, body: { error, error_description: description } };
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function hostOf(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return "dcr";
  }
}

async function parseForm(req: Request): Promise<URLSearchParams | null> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith("application/x-www-form-urlencoded")) return null;
  const text = await req.text().catch(() => null);
  if (text === null || text.length > 8192) return null;
  const p = new URLSearchParams(text);
  // RFC 6749 §3.2: parameters MUST NOT be included more than once.
  for (const k of new Set(p.keys())) if (p.getAll(k).length > 1) return null;
  return p;
}

async function activeClient(store: OAuthStore, clientId: string) {
  if (!clientId || clientId.length > 512) return null;
  const c = await store.getClient(clientId);
  if (!c || c.status !== "active") return null;
  if (c.registrationType === "dcr" && !isMcpOAuthDcrEnabled()) return null;
  return c;
}

function grantUsable(g: OAuthGrantRecord | null, now: Date): g is OAuthGrantRecord {
  return Boolean(g && g.status === "active" && Date.parse(g.expiresAt) > now.getTime() && isOrgAllowedForOAuth(g.orgId));
}

async function revokeGrantFamily(deps: TokenDeps, grant: OAuthGrantRecord, reason: string, nowIso: string) {
  await deps.store.revokeGrant(grant.id, "system", reason, nowIso);
  await deps.store.revokeTokensForGrant(grant.id, nowIso);
}

async function issueTokens(deps: TokenDeps, grant: OAuthGrantRecord, parentHash: string | null, now: Date) {
  const grantExp = Date.parse(grant.expiresAt);
  const accessExp = Math.min(now.getTime() + ACCESS_TOKEN_TTL_SEC * 1000, grantExp);
  const refreshExp = Math.min(now.getTime() + REFRESH_TOKEN_TTL_SEC * 1000, grantExp);
  const at = mintAccessToken();
  const rt = mintRefreshToken();
  await deps.store.createAccessToken({ tokenHash: at.hash, grantId: grant.id, expiresAt: new Date(accessExp).toISOString() });
  await deps.store.createRefreshToken({ tokenHash: rt.hash, grantId: grant.id, parentHash, expiresAt: new Date(refreshExp).toISOString() });
  return {
    at,
    rt,
    body: {
      access_token: at.raw,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.floor((accessExp - now.getTime()) / 1000)),
      refresh_token: rt.raw,
      scope: grant.scope.join(" "),
    } as Json,
  };
}

function resourceOk(param: string | null, grantResource: string): boolean {
  if (param === null) return true;
  const r = param.replace(/\/+$/, "");
  return allowedOAuthResources().includes(r) && r === grantResource;
}

export async function handleTokenRequest(req: Request, deps: TokenDeps): Promise<EndpointResult> {
  const form = await parseForm(req);
  if (!form) return err(400, "invalid_request", "application/x-www-form-urlencoded body with unique parameters required");
  const clientId = form.get("client_id") || "";
  const ip = deps.ipHash(req);
  if (!ip) return err(503, "temporarily_unavailable", "rate limiter not configured");
  const rl = await deps.rateLimit(`token:${sha256Hex(clientId).slice(0, 16)}:${ip}`, OAUTH_RATE_LIMITS.tokenPerClientIpPerMin, 60);
  if (!rl.allowed) return { ...err(429, "slow_down", "too many requests"), headers: { "Retry-After": String(rl.retryAfterSec) } };

  const client = await activeClient(deps.store, clientId);
  if (!client) return err(401, "invalid_client", "unknown or inactive client");
  if (form.has("client_secret")) return err(401, "invalid_client", "public clients only (token_endpoint_auth_method=none)");

  const now = deps.now();
  const nowIso = now.toISOString();
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = form.get("code") || "";
    const redirectUri = form.get("redirect_uri") || "";
    const verifier = form.get("code_verifier") || "";
    if (!code || !redirectUri || !VERIFIER_RE.test(verifier)) {
      return err(400, "invalid_request", "code, redirect_uri and a valid code_verifier are required");
    }
    const consumed = await deps.store.consumeCode(sha256Hex(code), nowIso);
    if (!consumed.ok) {
      if (consumed.reason === "already_consumed" && consumed.record) {
        const g = await deps.store.getGrant(consumed.record.grantId);
        if (g && g.status === "active") {
          await revokeGrantFamily(deps, g, "code_reuse", nowIso);
          await deps.audit({
            orgId: g.orgId,
            employeeId: g.employeeId,
            credentialId: null,
            action: "oauth.code_reuse_detected",
            purpose: null,
            summary: `認可コードの再利用を検知し、${hostOf(g.clientId)} への接続を取り消しました`,
            metadata: { grantId: g.id, clientHost: hostOf(g.clientId), codeHashPrefix: hashPrefix(sha256Hex(code)) },
          });
          await deps.notifySecurity({ orgId: g.orgId, employeeId: g.employeeId, clientHost: hostOf(g.clientId), kind: "code_reuse" }).catch(() => undefined);
        }
      }
      return err(400, "invalid_grant", "authorization code is invalid, expired or already used");
    }
    const c = consumed.record;
    if (c.clientId !== client.clientId || c.redirectUri !== redirectUri || !safeEq(s256(verifier), c.codeChallenge)) {
      return err(400, "invalid_grant", "code does not match client, redirect_uri or PKCE verifier");
    }
    const grant = await deps.store.getGrant(c.grantId);
    if (!grantUsable(grant, now) || grant.clientId !== client.clientId) return err(400, "invalid_grant", "grant revoked or expired");
    if (!resourceOk(form.get("resource"), grant.resource)) return err(400, "invalid_target", "resource does not match the grant");

    const issued = await issueTokens(deps, grant, null, now);
    await deps.audit({
      orgId: grant.orgId,
      employeeId: grant.employeeId,
      credentialId: grant.credentialIdAtGrant,
      action: "oauth.token_issued",
      purpose: null,
      summary: `${hostOf(grant.clientId)} にアクセストークンを発行`,
      metadata: {
        grantId: grant.id,
        clientHost: hostOf(grant.clientId),
        accessHashPrefix: hashPrefix(issued.at.hash),
        refreshHashPrefix: hashPrefix(issued.rt.hash),
      },
    });
    return { status: 200, body: issued.body };
  }

  if (grantType === "refresh_token") {
    const raw = form.get("refresh_token") || "";
    if (!raw) return err(400, "invalid_request", "refresh_token is required");
    const hash = sha256Hex(raw);
    const existing = await deps.store.getRefreshToken(hash);
    if (!existing) return err(400, "invalid_grant", "refresh token is invalid");
    const grant = await deps.store.getGrant(existing.grantId);
    if (!grant || grant.clientId !== client.clientId) return err(400, "invalid_grant", "refresh token is invalid");

    const rotated = await deps.store.rotateRefreshToken(hash, nowIso);
    if (!rotated.ok) {
      const rec = rotated.record;
      if (rotated.reason === "already_consumed" && rec && !rec.revokedAt && rec.rotatedAt) {
        const age = now.getTime() - Date.parse(rec.rotatedAt);
        if (age > REFRESH_REUSE_GRACE_SEC * 1000 && grant.status === "active") {
          await revokeGrantFamily(deps, grant, "refresh_reuse", nowIso);
          await deps.audit({
            orgId: grant.orgId,
            employeeId: grant.employeeId,
            credentialId: null,
            action: "oauth.refresh_reuse_detected",
            purpose: null,
            summary: `リフレッシュトークンの再利用を検知し、${hostOf(grant.clientId)} への接続を取り消しました`,
            metadata: { grantId: grant.id, clientHost: hostOf(grant.clientId), refreshHashPrefix: hashPrefix(hash) },
          });
          await deps.notifySecurity({ orgId: grant.orgId, employeeId: grant.employeeId, clientHost: hostOf(grant.clientId), kind: "refresh_reuse" }).catch(() => undefined);
        }
      }
      return err(400, "invalid_grant", "refresh token is invalid, expired or already used");
    }
    if (!grantUsable(grant, now)) {
      await deps.store.revokeRefreshToken(hash, nowIso);
      return err(400, "invalid_grant", "grant revoked or expired");
    }
    if (!resourceOk(form.get("resource"), grant.resource)) return err(400, "invalid_target", "resource does not match the grant");
    const scopeParam = form.get("scope");
    if (scopeParam && !scopeParam.split(/\s+/).filter(Boolean).every((s) => grant.scope.includes(s))) {
      return err(400, "invalid_scope", "scope exceeds the grant");
    }
    const issued = await issueTokens(deps, grant, hash, now);
    return { status: 200, body: issued.body };
  }

  return err(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

export async function handleRevokeRequest(req: Request, deps: TokenDeps): Promise<EndpointResult> {
  const form = await parseForm(req);
  if (!form) return err(400, "invalid_request", "application/x-www-form-urlencoded body with unique parameters required");
  const ip = deps.ipHash(req);
  if (!ip) return err(503, "temporarily_unavailable", "rate limiter not configured");
  const clientId = form.get("client_id") || "";
  const rl = await deps.rateLimit(`revoke:${sha256Hex(clientId).slice(0, 16)}:${ip}`, OAUTH_RATE_LIMITS.tokenPerClientIpPerMin, 60);
  if (!rl.allowed) return { ...err(429, "slow_down", "too many requests"), headers: { "Retry-After": String(rl.retryAfterSec) } };

  const token = form.get("token") || "";
  const ok: EndpointResult = { status: 200, body: null };
  if (!token) return err(400, "invalid_request", "token is required");
  const client = await activeClient(deps.store, clientId);
  if (!client) return err(401, "invalid_client", "unknown or inactive client");

  const nowIso = deps.now().toISOString();
  const hash = sha256Hex(token);
  // RFC 7009 §2.2: unknown / foreign tokens → still 200 (no oracle).
  const rt = await deps.store.getRefreshToken(hash);
  if (rt) {
    const g = await deps.store.getGrant(rt.grantId);
    if (g && g.clientId === client.clientId && g.status === "active") {
      await revokeGrantFamily(deps, g, "client_revocation", nowIso);
      await deps.audit({
        orgId: g.orgId,
        employeeId: g.employeeId,
        credentialId: null,
        action: "oauth.grant_revoked",
        purpose: null,
        summary: `${hostOf(g.clientId)} が接続を解除しました`,
        metadata: { grantId: g.id, clientHost: hostOf(g.clientId), reason: "client_revocation" },
      });
    }
    return ok;
  }
  const at = await deps.store.getAccessToken(hash);
  if (at) {
    const g = await deps.store.getGrant(at.grantId);
    if (g && g.clientId === client.clientId) await deps.store.revokeAccessToken(hash, nowIso);
  }
  return ok;
}

export async function defaultTokenDeps(): Promise<TokenDeps> {
  const [{ appendAuditEvent }, rl, notify] = await Promise.all([
    import("@/lib/data/audit"),
    import("@/lib/mcp-oauth/rate-limit"),
    import("@/lib/mcp-oauth/notify"),
  ]);
  return {
    store: getOAuthStore(),
    now: () => new Date(),
    audit: appendAuditEvent,
    notifySecurity: notify.notifyOAuthSecurityEvent,
    rateLimit: (b, l, w) => rl.rateLimit(b, l, w),
    ipHash: rl.ipHash,
  };
}

export function toResponse(r: EndpointResult): Response {
  return new Response(r.body === null ? null : JSON.stringify(r.body), {
    status: r.status,
    headers: { ...TOKEN_RESPONSE_HEADERS, ...(r.headers ?? {}) },
  });
}
