import { NextResponse } from "next/server";
import { getOAuthStore } from "@/lib/data/oauth";
import { isMcpOAuthDcrEnabled } from "@/lib/mcp-oauth/config";
import { notifyOpsDcrGlobalCapReached } from "@/lib/mcp-oauth/notify";
import { OAUTH_RATE_LIMITS, ipHash, rateLimit } from "@/lib/mcp-oauth/rate-limit";
import { matchesRedirectAllowlist } from "@/lib/mcp-oauth/redirect-policy";
import { randomToken } from "@/lib/mcp-oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const err = (status: number, error: string, description: string, extra: Record<string, string> = {}) =>
  NextResponse.json({ error, error_description: description }, { status, headers: { ...NO_STORE, ...extra } });

/**
 * RFC 7591 Dynamic Client Registration — MCP_OAUTH_DCR_ENABLED only (Q7).
 * Public clients only; every redirect_uri must pass the allowlist; registering
 * grants nothing until a tenant admin consents. client_name is untrusted.
 * Per-IP bucket = ipHash (an IPv6 client counts as its /64). Unconsented
 * registrations are deleted after a day by /api/cron/oauth-purge.
 */
export async function POST(req: Request) {
  if (!isMcpOAuthDcrEnabled()) return new NextResponse("Not Found", { status: 404 });
  const ip = ipHash(req);
  if (!ip) return err(503, "temporarily_unavailable", "rate limiter not configured");

  const perIp = await rateLimit(`dcr:${ip}`, OAUTH_RATE_LIMITS.dcrPerIpPerHour, 3600);
  if (!perIp.allowed) return err(429, "too_many_requests", "registration rate limit", { "Retry-After": String(perIp.retryAfterSec) });
  const store = getOAuthStore();
  const since = new Date(Date.now() - 86400_000).toISOString();
  const recent = await store.countDcrClientsSince(since);
  if (recent >= OAUTH_RATE_LIMITS.dcrGlobalPerDay) {
    // #318 follow-up: tell ops once per day (not once per refused request).
    try {
      const first = await rateLimit("dcr_global_cap_alert", 1, 86400);
      if (first.count === 1) await notifyOpsDcrGlobalCapReached({ count: recent, cap: OAUTH_RATE_LIMITS.dcrGlobalPerDay });
    } catch {
      /* best-effort: the 429 stands either way */
    }
    return err(429, "too_many_requests", "global registration limit");
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "invalid_client_metadata", "JSON object required");
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every((u) => typeof u === "string" && matchesRedirectAllowlist(u))) {
    return err(400, "invalid_redirect_uri", "every redirect_uri must be on the server allowlist");
  }
  const method = body.token_endpoint_auth_method ?? "none";
  if (method !== "none") return err(400, "invalid_client_metadata", "only public clients (none) are supported");
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"];
  if (!grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
    return err(400, "invalid_client_metadata", "unsupported grant_types");
  }
  const responseTypes = Array.isArray(body.response_types) ? body.response_types : ["code"];
  if (!responseTypes.every((r) => r === "code")) return err(400, "invalid_client_metadata", "unsupported response_types");

  const clientName = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 120) : "";
  const clientId = `dcr_${randomToken(18)}`;
  const now = new Date().toISOString();
  await store.upsertClient({
    clientId,
    registrationType: "dcr",
    clientName,
    clientUri: null,
    logoUri: null,
    redirectUris: redirectUris as string[],
    tokenEndpointAuthMethod: "none",
    metadata: { unverified: true },
    metadataFetchedAt: null,
    metadataExpiresAt: null,
    status: "active",
    createdIpHash: ip,
    createdAt: now,
  });
  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.parse(now) / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: grantTypes,
      response_types: ["code"],
    },
    { status: 201, headers: NO_STORE }
  );
}
