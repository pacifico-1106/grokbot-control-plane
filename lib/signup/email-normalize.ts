/**
 * Email normalization for duplicate / dot-trick detection (NOT for delivery).
 * - lower-case, trim
 * - googlemail.com → gmail.com; Gmail ignores dots and +tags
 * - +tag stripped for providers that support sub-addressing
 * Signals feed the spam score (lib/spam/score.ts) and the optional domain check.
 */
import { createHash } from "node:crypto";
import { isDisposableDomain } from "./disposable-domains";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const PLUS_TAG_DOMAINS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com",
  "me.com", "fastmail.com", "proton.me", "protonmail.com", "pm.me", "yandex.com",
]);

export type EmailSignal =
  | "disposable_domain"
  | "gmail_dot_trick"
  | "invalid_dots"
  | "plus_tag"
  | "numeric_heavy_local";

export type NormalizedEmail = {
  /** Lower-cased address as typed. */
  raw: string;
  local: string;
  domain: string;
  /** Canonical mailbox for dedupe. */
  normalized: string;
  signals: EmailSignal[];
};

export function normalizeEmail(input: string): NormalizedEmail | null {
  const raw = (input || "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return null;
  const local = raw.slice(0, at);
  let domain = raw.slice(at + 1).replace(/\.$/, "");
  if (!local || !domain || !domain.includes(".")) return null;
  const signals: EmailSignal[] = [];

  if (/^\.|\.$|\.\./.test(local)) signals.push("invalid_dots");
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com";
    const dots = (local.split("+")[0].match(/\./g) || []).length;
    if (dots >= 2) signals.push("gmail_dot_trick");
  }

  let mailbox = local;
  if (PLUS_TAG_DOMAINS.has(domain) && mailbox.includes("+")) {
    mailbox = mailbox.slice(0, mailbox.indexOf("+"));
    signals.push("plus_tag");
  }
  if (domain === "gmail.com") mailbox = mailbox.replace(/\./g, "");

  const digits = (mailbox.match(/[0-9]/g) || []).length;
  if (mailbox.length >= 6 && digits / mailbox.length >= 0.5) signals.push("numeric_heavy_local");
  if (isDisposableDomain(domain)) signals.push("disposable_domain");

  return { raw, local, domain, normalized: `${mailbox}@${domain}`, signals };
}

function hashKey(): string {
  return process.env.IP_HASH_KEY || "default_hash_key_for_dev";
}

/** Keyed hash (same key as IP hashing) so the log never stores the address. */
export function keyedHash(value: string, length = 32): string {
  return createHash("sha256").update(`${hashKey()}:${value}`).digest("hex").slice(0, length);
}
