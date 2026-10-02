/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document).
 * SSRF controls (S8): https only, path required, host allowlist, every resolved
 * IP public, no redirects followed, 5 s timeout, 64 KB cap, JSON only,
 * client_id must equal the document URL exactly. Cached 5 min – 24 h.
 * Residual: DNS rebinding between lookup and fetch is bounded by the host
 * allowlist (only chatgpt.com / claude.ai / claude.com / anthropic.com by default).
 */
import { getOAuthStore, type OAuthClientRecord } from "@/lib/data/oauth";
import { cimdAllowedHosts } from "@/lib/mcp-oauth/config";
import { defaultResolver, isPrivateAddress, type HostResolver } from "@/lib/mcp-oauth/net-guard";
import { matchesRedirectAllowlist } from "@/lib/mcp-oauth/redirect-policy";

export const CIMD_MAX_BYTES = 64 * 1024;
export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_MIN_TTL_SEC = 300;
export const CIMD_MAX_TTL_SEC = 86400;

export type CimdError =
  | "not_cimd_url"
  | "host_not_allowed"
  | "private_address"
  | "fetch_failed"
  | "redirect_refused"
  | "too_large"
  | "not_json"
  | "client_id_mismatch"
  | "invalid_metadata"
  | "no_allowed_redirect"
  | "unsupported_auth_method";

export type CimdResult = { ok: true; client: OAuthClientRecord; cached: boolean } | { ok: false; error: CimdError };

export function isCimdClientId(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return u.protocol === "https:" && u.pathname.length > 1 && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

function ttlFromCacheControl(header: string | null): number {
  const m = /max-age=(\d+)/i.exec(header || "");
  const v = m ? Number(m[1]) : CIMD_MIN_TTL_SEC;
  return Math.min(CIMD_MAX_TTL_SEC, Math.max(CIMD_MIN_TTL_SEC, v));
}

async function readCapped(res: Response): Promise<string | null> {
  const len = Number(res.headers.get("content-length") || "0");
  if (len > CIMD_MAX_BYTES) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CIMD_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type CimdDeps = { fetchImpl?: typeof fetch; resolveHost?: HostResolver; now?: Date };

export async function resolveCimdClient(clientId: string, deps: CimdDeps = {}): Promise<CimdResult> {
  if (!isCimdClientId(clientId)) return { ok: false, error: "not_cimd_url" };
  const url = new URL(clientId);
  const host = url.hostname.toLowerCase();
  if (!cimdAllowedHosts().includes(host) || url.port) return { ok: false, error: "host_not_allowed" };

  const now = deps.now ?? new Date();
  const store = getOAuthStore();
  const cached = await store.getClient(clientId);
  if (
    cached &&
    cached.registrationType === "cimd" &&
    cached.status === "active" &&
    cached.metadataExpiresAt &&
    Date.parse(cached.metadataExpiresAt) > now.getTime()
  ) {
    return { ok: true, client: cached, cached: true };
  }
  if (cached?.status === "blocked") return { ok: false, error: "invalid_metadata" };

  const resolveHost = deps.resolveHost ?? defaultResolver;
  let addrs: string[];
  try {
    addrs = await resolveHost(host);
  } catch {
    return { ok: false, error: "fetch_failed" };
  }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) return { ok: false, error: "private_address" };

  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(clientId, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "fetch_failed" };
  }
  if (res.status >= 300 && res.status < 400) return { ok: false, error: "redirect_refused" };
  if (res.status !== 200) return { ok: false, error: "fetch_failed" };
  if (!(res.headers.get("content-type") || "").toLowerCase().includes("json")) return { ok: false, error: "not_json" };
  const text = await readCapped(res);
  if (text == null) return { ok: false, error: "too_large" };

  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "not_json" };
    doc = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "not_json" };
  }

  if (doc.client_id !== clientId) return { ok: false, error: "client_id_mismatch" };
  const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (typeof doc.client_name !== "string" || !doc.client_name.trim() || redirectUris.length === 0) {
    return { ok: false, error: "invalid_metadata" };
  }
  const method = doc.token_endpoint_auth_method ?? "none";
  if (method !== "none") return { ok: false, error: "unsupported_auth_method" };
  const allowed = redirectUris.filter((u) => matchesRedirectAllowlist(u));
  if (allowed.length === 0) return { ok: false, error: "no_allowed_redirect" };

  const ttl = ttlFromCacheControl(res.headers.get("cache-control"));
  const str = (v: unknown, max = 512) => (typeof v === "string" && v.length <= max ? v : null);
  const client = await store.upsertClient({
    clientId,
    registrationType: "cimd",
    clientName: doc.client_name.trim().slice(0, 120),
    clientUri: str(doc.client_uri),
    logoUri: str(doc.logo_uri),
    redirectUris: allowed,
    tokenEndpointAuthMethod: "none",
    metadata: { grant_types: doc.grant_types ?? null, software_id: str(doc.software_id, 200), declared_redirect_count: redirectUris.length },
    metadataFetchedAt: now.toISOString(),
    metadataExpiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    status: "active",
    createdIpHash: null,
  });
  return { ok: true, client, cached: false };
}
