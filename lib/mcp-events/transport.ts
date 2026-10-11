/**
 * SSRF-safe webhook POST for MCP Events (deliveries and the verification
 * challenge). Invariants (spec "Webhook Security → SSRF prevention"):
 * - https, port 443, no userinfo / fragment, hostname (not an IP literal),
 *   no single-label / internal-only names, URL ≤ 2048 chars;
 * - DNS is resolved on EVERY attempt; EVERY answer must be globally routable
 *   (a non-public answer is a permanent failure: address_blocked, not retried)
 *   (lib/security/public-file-download.ts isPublicDownloadAddress: private,
 *   loopback, link-local / metadata, CGNAT, ULA, mapped, documentation … are
 *   refused); the checked answer is pinned for the TCP connection and the
 *   hostname is sent only as TLS SNI + Host, so a rebinding answer between
 *   check and connect cannot be used;
 * - redirects are never followed (3xx = failure, not retried);
 * - request body ≤ 256 KiB, response read ≤ 64 KiB, ~5 s OVERALL timeout
 *   after which the response, the request and its socket are destroyed;
 * - failures surface as fixed categories only (never raw endpoint text).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
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
  /** D9: the legacy callback / wake keep their own User-Agent (default Staffpass-MCP-Events/1.0). */
  userAgent?: string;
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
      "user-agent": req.userAgent || "Staffpass-MCP-Events/1.0",
    },
  };
}

const timeoutError = () => Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });

/**
 * node:https transport with the pinned options. Two timers:
 * - `setTimeout` on the request = socket idle timeout;
 * - an OVERALL deadline (req.timeoutMs from the start) that destroys the
 *   response stream, the request and its socket even when data keeps
 *   trickling in (an idle timer alone never fires for a slow-drip receiver).
 * An aborted `req.signal` (postWebhook's own deadline) tears down the same way.
 * `deps.request` is a test seam (defaults to node:https request).
 */
export function createNodeWebhookTransport(deps: { request?: typeof httpsRequest } = {}): WebhookTransport {
  const doRequest = deps.request ?? httpsRequest;
  return {
    lookup: async (hostname) =>
      (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({
        address: a.address,
        family: a.family === 6 ? 6 : 4,
      })),
    request: (req) =>
      new Promise((resolve, reject) => {
        let settled = false;
        let response: IncomingMessage | null = null;
        let r: ClientRequest | null = null;
        // OVERALL deadline from the start (not an idle timer).
        const deadline = setTimeout(() => teardown(timeoutError()), req.timeoutMs);
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          req.signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const teardown = (e: Error) => {
          finish(() => reject(e));
          try { response?.destroy(); } catch { /* already gone */ }
          try { r?.destroy(e); } catch { /* already gone */ }
        };
        const onAbort = () => teardown(timeoutError());
        const request = doRequest(buildPinnedRequestOptions(req), (res) => {
          response = res;
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > req.maxResponseBytes) {
              const status = res.statusCode || 0;
              const body = Buffer.concat(chunks);
              finish(() => resolve({ status, body }));
              res.destroy();
              request.destroy();
            } else chunks.push(chunk);
          });
          res.on("end", () => finish(() => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) })));
          res.on("error", (e) => teardown(e instanceof Error ? e : new Error("response_error")));
        });
        r = request;
        request.setTimeout(req.timeoutMs, () => teardown(timeoutError())); // socket idle timeout
        request.on("error", (e: Error) => finish(() => reject(e)));
        if (req.signal) {
          if (req.signal.aborted) { teardown(timeoutError()); return; }
          req.signal.addEventListener("abort", onAbort, { once: true });
        }
        request.end(req.body);
      }),
  };
}

/** Production transport: system resolver (all answers) + pinned node:https request. */
export function defaultWebhookTransport(): WebhookTransport {
  return createNodeWebhookTransport();
}

function categorizeError(e: unknown): { category: DeliveryErrorCategory; reason: string } {
  const code = String((e as { code?: unknown })?.code || "");
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ABORT_ERR") return { category: "timeout", reason: "timeout" };
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL)/.test(code) || code.includes("CERT")) {
    return { category: "tls_error", reason: "tls_error" };
  }
  return { category: "connection_refused", reason: "connect_failed" };
}

/** Race against a deadline; on expiry the controller is aborted so the transport tears the connection down. */
async function withTimeout<T>(p: Promise<T>, ms: number, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(timeoutError());
        }, ms);
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
  opts: { timeoutMs?: number; userAgent?: string } = {}
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
  if (!answers.length) return { ok: false, category: "connection_refused", reason: "dns_failed", retryable: true };
  // A non-public answer is permanent for this delivery (never retried): the
  // receiver resolves to an internal / metadata address, or is rebinding.
  if (answers.some((a) => !isPublicDownloadAddress(a.address))) {
    return { ok: false, category: "connection_refused", reason: "address_blocked", retryable: false };
  }
  const pinned = answers[0];
  let res: { status: number; body: Buffer };
  const controller = new AbortController();
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
        signal: controller.signal,
        ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      }),
      timeoutMs + 500,
      controller
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
