/**
 * Standard Webhooks profile used by MCP Events webhook delivery
 * (Triggers & Events extension on MCP 2026-07-28):
 *   webhook-signature = "v1," + base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`))
 * key = base64-decoded bytes after "whsec_" (client supplied, 24–64 bytes).
 * Several space-separated signatures are sent during secret rotation.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseWhsecSecret(
  value: unknown
): { ok: true; key: Buffer } | { ok: false; reason: string } {
  if (typeof value !== "string" || !value.startsWith("whsec_")) return { ok: false, reason: "secret_format" };
  const encoded = value.slice("whsec_".length);
  if (!encoded || encoded.length > 128 || !BASE64.test(encoded) || encoded.length % 4 !== 0) {
    return { ok: false, reason: "secret_format" };
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length < 24 || key.length > 64) return { ok: false, reason: "secret_length" };
  return { ok: true, key };
}

function hmac(key: Buffer, id: string, timestampSec: number | string, body: string): string {
  return createHmac("sha256", key).update(`${id}.${timestampSec}.${body}`, "utf8").digest("base64");
}

export function signStandardWebhook(keys: Buffer[], id: string, timestampSec: number, body: string): string {
  return keys.map((key) => `v1,${hmac(key, id, timestampSec, body)}`).join(" ");
}

/** Receiver-side check (used by tests and by receivers that want a reference). */
export function verifyStandardWebhook(
  key: Buffer,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  opts: { nowSec?: number; toleranceSec?: number } = {}
): boolean {
  const ts = Number(headers.timestamp);
  if (!Number.isInteger(ts)) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSec ?? 300)) return false;
  const expected = Buffer.from(hmac(key, headers.id, ts, body));
  return headers.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
