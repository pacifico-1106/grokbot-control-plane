import { createHmac } from "node:crypto";
import { requirePhoneHashKey } from "@/lib/inbound-notice/phone-hash-key";

function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** Last 4 digits, or null when fewer than 4 (never return the whole short number). */
export function last4Digits(value: string | null | undefined): string | null {
  const d = digits(value);
  if (d.length < 4) return null;
  return d.slice(-4);
}

/**
 * HMAC-SHA256 of the digit string with INBOUND_CALL_NOTICE_PHONE_HASH_KEY.
 * Throws PhoneHashKeyMissingError when the pepper is unset (no unsalted fallback).
 */
export function hashPhone(value: string | null | undefined): string | null {
  const d = digits(value);
  if (!d) return null;
  const key = requirePhoneHashKey();
  return `hmac-sha256:${createHmac("sha256", key).update(d, "utf8").digest("hex")}`;
}

export function maskPhoneForAudit(value: string | null | undefined): {
  phoneLast4: string | null;
  phoneHash: string | null;
} {
  return { phoneLast4: last4Digits(value), phoneHash: hashPhone(value) };
}
