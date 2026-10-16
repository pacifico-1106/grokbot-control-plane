import { createHash } from "node:crypto";

function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** Last 4 digits, or null when fewer than 4 (never return the whole short number). */
export function last4Digits(value: string | null | undefined): string | null {
  const d = digits(value);
  if (d.length < 4) return null;
  return d.slice(-4);
}

/** SHA-256 of the digit string. Not a secret; phone space is small (open decision: pepper). */
export function hashPhone(value: string | null | undefined): string | null {
  const d = digits(value);
  if (!d) return null;
  return `sha256:${createHash("sha256").update(d, "utf8").digest("hex")}`;
}

export function maskPhoneForAudit(value: string | null | undefined): {
  phoneLast4: string | null;
  phoneHash: string | null;
} {
  return { phoneLast4: last4Digits(value), phoneHash: hashPhone(value) };
}
