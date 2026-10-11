/**
 * D9 (八坂 GO 2026-10-05): shared helpers for the two pre-existing outbound
 * webhooks — the approval.resolved callback (employee.callbackUrl,
 * lib/approvals/resolve-side-effects.ts) and the conversation wake webhook
 * (binding.wakeWebhookUrl, lib/slack/mention-ingress.ts postWake).
 *
 * - Failure categories: the ONLY thing an approver-facing API response or an
 *   audit row ever carries about a failed delivery (never raw error text, the
 *   receiver's status or body). Used with the flag ON and OFF.
 * - WEBHOOK_HARDENING_ENABLED ON: postHardenedWebhook = #267's postWebhook
 *   (https, port 443, hostname only, every DNS answer must be public, the
 *   checked address is pinned, redirects never followed, 256 KiB body cap,
 *   overall timeout with socket teardown) + Standard Webhooks headers.
 */
import { createHash } from "node:crypto";
import { ADDRESS_BLOCKED_CODE } from "@/lib/webhooks/link-local-guard";
import { parseWhsecSecret, signStandardWebhook } from "@/lib/mcp-events/standard-webhooks";
// Type-only: the transport (and its SSRF address check) is loaded lazily in
// postHardenedWebhook, so the flag-OFF path never loads it (D9).
import type { PostResult, WebhookTransport } from "@/lib/mcp-events/transport";

export const WEBHOOK_FAILURE_CATEGORIES = [
  "invalid_url",
  "address_blocked",
  "dns_failed",
  "connection_failed",
  "tls_error",
  "timeout",
  "redirect_refused",
  "http_4xx",
  "http_5xx",
  "body_too_large",
  "config_unavailable",
] as const;
export type WebhookFailureCategory = (typeof WEBHOOK_FAILURE_CATEGORIES)[number];

const INVALID_URL_REASONS = new Set([
  "url_invalid",
  "https_required",
  "userinfo_not_allowed",
  "fragment_not_allowed",
  "port_not_allowed",
  "ip_literal_not_allowed",
  "hostname_not_allowed",
]);

/** postWebhook failure → category (reason codes are fixed strings from transport.ts). */
export function categorizePostFailure(r: Extract<PostResult, { ok: false }>): WebhookFailureCategory {
  if (INVALID_URL_REASONS.has(r.reason)) return "invalid_url";
  switch (r.reason) {
    case "address_blocked": return "address_blocked";
    case "dns_failed": return "dns_failed";
    case "redirect_refused": return "redirect_refused";
    case "body_too_large": return "body_too_large";
    default: break;
  }
  if (r.category === "timeout") return "timeout";
  if (r.category === "tls_error") return "tls_error";
  if (r.category === "http_5xx") return "http_5xx";
  if (r.category === "http_4xx") return "http_4xx";
  return "connection_failed";
}

/** Final HTTP status → category; null for 2xx. */
export function categorizeHttpStatus(status: number): WebhookFailureCategory | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) return "redirect_refused";
  if (status >= 500) return "http_5xx";
  return "http_4xx";
}

/** Legacy fetch() failure (flag OFF) → category. The message is never kept. */
export function categorizeFetchError(e: unknown): WebhookFailureCategory {
  const err = e as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const name = String(err?.name || "");
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const code = String(err?.cause?.code || err?.code || "");
  // Link-local / metadata destination refused at connect time (no flag).
  if (code === ADDRESS_BLOCKED_CODE) return "address_blocked";
  if (code === "ERR_INVALID_URL") return "invalid_url";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return "dns_failed";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") return "timeout";
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL)/.test(code) || code.includes("CERT")) return "tls_error";
  return "connection_failed";
}

/**
 * Signing key for a configured secret: a `whsec_…` secret is used as Standard
 * Webhooks defines it (base64-decoded bytes); any other non-empty secret (the
 * existing free-form wake-webhook secret) is used as its UTF-8 bytes — the
 * receiver verifies with receiverWhsecFor(secret).
 */
export function signingKeyFromSecret(secret: string | null | undefined): Buffer | null {
  const s = (secret ?? "").trim();
  if (!s) return null;
  const parsed = parseWhsecSecret(s);
  return parsed.ok ? parsed.key : Buffer.from(s, "utf8");
}

/** The `whsec_…` string a standard receiver library needs for `secret`. */
export function receiverWhsecFor(secret: string): string {
  const s = secret.trim();
  return parseWhsecSecret(s).ok ? s : `whsec_${Buffer.from(s, "utf8").toString("base64")}`;
}

/** webhook-id + webhook-timestamp always; webhook-signature only with a key. */
export function standardWebhookHeaders(key: Buffer | null, msgId: string, timestampSec: number, body: string): Record<string, string> {
  const headers: Record<string, string> = { "webhook-id": msgId, "webhook-timestamp": String(timestampSec) };
  if (key) headers["webhook-signature"] = signStandardWebhook([key], msgId, timestampSec, body);
  return headers;
}

/** Deterministic id for one logical message (retries / repeats share it); input is hashed, never embedded. */
export function stableWebhookId(prefix: string, parts: string[]): string {
  const h = createHash("sha256").update(JSON.stringify([prefix, ...parts]), "utf8").digest("hex").slice(0, 32);
  return `msg_${prefix}_${h}`;
}

let transportOverride: WebhookTransport | null = null;
export function __setOutboundWebhookTransportForTests(t: WebhookTransport | null): void { transportOverride = t; }

export type HardenedPostResult = { ok: true } | { ok: false; category: WebhookFailureCategory };

export async function postHardenedWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs: number; userAgent?: string }
): Promise<HardenedPostResult> {
  let res: PostResult;
  try {
    const { defaultWebhookTransport, postWebhook } = await import("@/lib/mcp-events/transport");
    res = await postWebhook(url, body, headers, transportOverride ?? defaultWebhookTransport(), opts);
  } catch {
    return { ok: false, category: "connection_failed" };
  }
  return res.ok ? { ok: true } : { ok: false, category: categorizePostFailure(res) };
}
