/**
 * SSRF-safe webhook POST for MCP Events (deliveries and the verification
 * challenge). Invariants (spec "Webhook Security → SSRF prevention"):
 * - https, port 443, no userinfo / fragment, hostname (not an IP literal),
 *   no single-label / internal-only names, URL ≤ 2048 chars;
 * - DNS is resolved on EVERY attempt; EVERY answer must be globally routable
 *   (lib/security/public-file-download.ts isPublicDownloadAddress: private,
 *   loopback, link-local / metadata, CGNAT, ULA, mapped, documentation … are
 *   refused); the checked answer is pinned for the TCP connection and the
 *   hostname is sent only as TLS SNI + Host, so a rebinding answer between
 *   check and connect cannot be used;
 * - redirects are never followed (3xx = failure, not retried);
 * - request body ≤ 256 KiB, response read ≤ 64 KiB, ~5 s timeout;
 * - failures surface as fixed categories only (never raw endpoint text).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { isPublicDownloadAddress } from "@/lib/security/public-file-download";
import { MCP_EVENTS_LIMITS } from "./policy";

export type DeliveryErrorCategory =
  | "connection_refused"
  | "timeout"
  | "tls_error"
  | "http_4xx"
  | "http_5xx"
  | "challenge_failed";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type PinnedRequest = {
  address: string;
  family: 4 | 6;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
};
export type WebhookTransport = {
  lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  request: (req: PinnedRequest) => Promise<{ status: number; body: Buffer }>;
};
export type PostResult =
  | { ok: true; status: number; body: Buffer }
  | { ok: false; category: DeliveryErrorCategory; reason: string; retryable: boolean; status?: number };

const MAX_URL = 2048;
const MAX_RESPONSE = 64 * 1024;
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp"];

export function validateCallbackUrl(raw: unknown): { ok: true; host: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URL) return { ok: false, reason: "url_invalid" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "url_invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "https_required" };
  if (url.username || url.password) return { ok: false, reason: "userinfo_not_allowed" };
  if (url.hash || raw.includes("#")) return { ok: false, reason: "fragment_not_allowed" };
  if (url.port && url.port !== "443") return { ok: false, reason: "port_not_allowed" };
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || isIP(host)) return { ok: false, reason: "ip_literal_not_allowed" };
  if (!host.includes(".") || host.endsWith(".")) return { ok: false, reason: "hostname_not_allowed" };
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s)) || host === "localhost") return { ok: false, reason: "hostname_not_allowed" };
  return { ok: true, host };
}

export function buildPinnedRequestOptions(req: PinnedRequest): RequestOptions {
  return {
    protocol: "https:",
    hostname: req.address,
    family: req.family,
    port: 443,
    path: req.path,
    servername: req.hostname,
    method: "POST",
    agent: false,
    rejectUnauthorized: true,
    headers: {
      ...req.headers,
      host: req.hostname,
      "content-length": String(req.body.length),
      "accept-encoding": "identity",
      "user-agent": "Staffpass-MCP-Events/1.0",
    },
  };
}

/** Production transport: system resolver (all answers) + pinned node:https request. */
export function defaultWebhookTransport(): WebhookTransport {
  return {
    lookup: async (hostname) =>
      (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({
        address: a.address,
        family: a.family === 6 ? 6 : 4,
      })),
    request: (req) =>
      new Promise((resolve, reject) => {
        const r = httpsRequest(buildPinnedRequestOptions(req), (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > req.maxResponseBytes) {
              res.destroy();
              resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) });
            } else chunks.push(chunk);
          });
          res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
          res.on("error", (e) => reject(e));
        });
        r.setTimeout(req.timeoutMs, () => r.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
        r.on("error", (e) => reject(e));
        r.end(req.body);
      }),
  };
}

function categorizeError(e: unknown): { category: DeliveryErrorCategory; reason: string } {
  const code = String((e as { code?: unknown })?.code || "");
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ABORT_ERR") return { category: "timeout", reason: "timeout" };
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL)/.test(code) || code.includes("CERT")) {
    return { category: "tls_error", reason: "tls_error" };
  }
  return { category: "connection_refused", reason: "connect_failed" };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function postWebhook(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  transport: WebhookTransport,
  opts: { timeoutMs?: number } = {}
): Promise<PostResult> {
  const checked = validateCallbackUrl(rawUrl);
  if (!checked.ok) return { ok: false, category: "connection_refused", reason: checked.reason, retryable: false };
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length > MCP_EVENTS_LIMITS.maxBodyBytes) {
    return { ok: false, category: "http_4xx", reason: "body_too_large", retryable: false };
  }
  const timeoutMs = opts.timeoutMs ?? MCP_EVENTS_LIMITS.attemptTimeoutMs;
  const url = new URL(rawUrl);
  let answers: ResolvedAddress[];
  try {
    answers = await withTimeout(transport.lookup(checked.host), timeoutMs);
  } catch {
    return { ok: false, category: "connection_refused", reason: "dns_failed", retryable: true };
  }
  if (!answers.length || answers.some((a) => !isPublicDownloadAddress(a.address))) {
    return { ok: false, category: "connection_refused", reason: "address_blocked", retryable: true };
  }
  const pinned = answers[0];
  let res: { status: number; body: Buffer };
  try {
    res = await withTimeout(
      transport.request({
        address: pinned.address,
        family: pinned.family,
        hostname: checked.host,
        path: `${url.pathname}${url.search}`,
        headers,
        body: bytes,
        timeoutMs,
        maxResponseBytes: MAX_RESPONSE,
      }),
      timeoutMs + 500
    );
  } catch (e) {
    return { ok: false, ...categorizeError(e), retryable: true };
  }
  const status = res.status;
  if (status >= 200 && status < 300) return { ok: true, status, body: res.body.subarray(0, MAX_RESPONSE) };
  if (status >= 300 && status < 400) return { ok: false, category: "http_4xx", reason: "redirect_refused", retryable: false, status };
  if (status === 410 || status === 413) return { ok: false, category: "http_4xx", reason: `http_${status}`, retryable: false, status };
  if (status >= 500) return { ok: false, category: "http_5xx", reason: "http_5xx", retryable: true, status };
  return { ok: false, category: "http_4xx", reason: "http_4xx", retryable: true, status };
}

export function createNodeWebhookTransport(_deps: { request?: typeof httpsRequest } = {}): WebhookTransport {
  void _deps;
  throw new Error("not_implemented");
}
