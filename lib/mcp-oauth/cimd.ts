/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document).
 * SSRF controls (S8, reland-8): https only on 443, path required, hostname
 * (never an IP literal) on the host allowlist; DNS is resolved ONCE and EVERY
 * answer must be public (net-guard isPrivateAddress); the TCP/TLS connection
 * is pinned to that checked answer (node:https to the IP, SNI + Host =
 * hostname, certificate verified against the hostname, socket `lookup`
 * pinned too), so a rebinding answer after the check is never used; no
 * redirects followed (node:https never follows; 3xx = redirect_refused);
 * identity encoding only; 64 KB cap (declared and streamed); one 5 s OVERALL
 * deadline covering DNS + connect + headers + body, after which the request
 * and socket are destroyed; JSON only; client_id must equal the document URL
 * exactly. Cached 5 min – 24 h.
 */
import type { ClientRequest, IncomingMessage, IncomingHttpHeaders, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { getOAuthStore, type OAuthClientRecord } from "@/lib/data/oauth";
import { cimdAllowedHosts } from "@/lib/mcp-oauth/config";
import { defaultResolver, isPrivateAddress, pinnedLookup, type HostResolver, type ResolvedAnswer } from "@/lib/mcp-oauth/net-guard";
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

/** DNS + node:https-style request. Injected in tests; production uses the system resolver and node:https. */
export type CimdTransport = {
  lookup: HostResolver;
  request: (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;
};
export const defaultCimdTransport = (): CimdTransport => ({ lookup: defaultResolver, request: httpsRequest });

export function buildCimdRequestOptions(pinned: ResolvedAnswer, hostname: string, path: string): RequestOptions & { servername: string; rejectUnauthorized: true } {
  return {
    protocol: "https:",
    hostname: pinned.address,
    family: pinned.family,
    port: 443,
    path,
    method: "GET",
    servername: hostname,
    rejectUnauthorized: true,
    agent: false,
    lookup: pinnedLookup(pinned),
    headers: {
      host: hostname,
      accept: "application/json",
      "accept-encoding": "identity",
      "user-agent": "Staffpass-OAuth-CIMD/1.0",
    },
  };
}

type FetchOutcome =
  | { ok: true; headers: IncomingHttpHeaders; body: string }
  | { ok: false; error: Extract<CimdError, "fetch_failed" | "private_address" | "redirect_refused" | "too_large"> };

const header = (h: IncomingHttpHeaders, name: string): string => {
  const v = h[name];
  return Array.isArray(v) ? v.join(", ") : v ?? "";
};

/** Resolve once, check every answer, connect pinned to the first, read ≤ CIMD_MAX_BYTES, all under one deadline. */
function fetchCimdDocument(hostname: string, path: string, t: CimdTransport, timeoutMs: number): Promise<FetchOutcome> {
  return new Promise<FetchOutcome>((resolve) => {
    let done = false;
    let req: ClientRequest | null = null;
    let res: IncomingMessage | null = null;
    const finish = (o: FetchOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { res?.destroy(); } catch { /* already gone */ }
      try { req?.destroy(); } catch { /* already gone */ }
      resolve(o);
    };
    const failed = () => finish({ ok: false, error: "fetch_failed" });
    const timer = setTimeout(failed, timeoutMs);
    let lookup: Promise<ResolvedAnswer[]>;
    try {
      lookup = Promise.resolve(t.lookup(hostname));
    } catch {
      return failed();
    }
    lookup.then((answers) => {
      if (done) return;
      if (!Array.isArray(answers) || answers.length === 0 || answers.some((a) => isPrivateAddress(String(a?.address ?? "")))) {
        return finish({ ok: false, error: "private_address" });
      }
      try {
        req = t.request(buildCimdRequestOptions(answers[0], hostname, path), (r) => {
          res = r;
          if (done) { r.destroy(); return; }
          const status = r.statusCode || 0;
          if (status >= 300 && status < 400) return finish({ ok: false, error: "redirect_refused" });
          if (status !== 200) return failed();
          const enc = header(r.headers, "content-encoding").trim().toLowerCase();
          if (enc && enc !== "identity") return failed();
          if (Number(header(r.headers, "content-length") || "0") > CIMD_MAX_BYTES) return finish({ ok: false, error: "too_large" });
          const chunks: Buffer[] = [];
          let size = 0;
          r.on("data", (chunk: Buffer | string) => {
            const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            size += b.length;
            if (size > CIMD_MAX_BYTES) finish({ ok: false, error: "too_large" });
            else chunks.push(b);
          });
          r.on("end", () => finish({ ok: true, headers: r.headers, body: Buffer.concat(chunks).toString("utf8") }));
          r.on("aborted", failed);
          r.on("error", failed);
        });
        req.on("error", failed);
        req.end();
      } catch {
        failed();
      }
    }, failed);
  });
}

export type CimdDeps = { transport?: CimdTransport; now?: Date; timeoutMs?: number };

export async function resolveCimdClient(clientId: string, deps: CimdDeps = {}): Promise<CimdResult> {
  if (!isCimdClientId(clientId)) return { ok: false, error: "not_cimd_url" };
  const url = new URL(clientId);
  const host = url.hostname.toLowerCase();
  // An IP literal is never a CIMD host, even if someone put one on the allowlist.
  if (host.startsWith("[") || isIP(host)) return { ok: false, error: "host_not_allowed" };
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

  const fetched = await fetchCimdDocument(host, `${url.pathname}${url.search}`, deps.transport ?? defaultCimdTransport(), deps.timeoutMs ?? CIMD_TIMEOUT_MS);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  if (!header(fetched.headers, "content-type").toLowerCase().includes("json")) return { ok: false, error: "not_json" };
  const text = fetched.body;

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

  const ttl = ttlFromCacheControl(header(fetched.headers, "cache-control") || null);
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
  }, { preserveStatus: true });
  // A block applied while we were fetching wins (hardening 3).
  if (client.status !== "active") return { ok: false, error: "invalid_metadata" };
  return { ok: true, client, cached: false };
}
