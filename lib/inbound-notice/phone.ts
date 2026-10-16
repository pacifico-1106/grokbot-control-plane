import { createHmac } from "node:crypto";
import { requirePhoneHashKey } from "@/lib/inbound-notice/phone-hash-key";

function halfWidthDigit(ch: string): string | null {
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return ch;
  if (c >= 0xff10 && c <= 0xff19) return String.fromCharCode(c - 0xfee0);
  return null;
}

function isDigitChar(ch: string): boolean {
  return halfWidthDigit(ch) !== null;
}

/** Phone separators: space, ASCII/fullwidth hyphen, dot, parentheses. Not / : , (date, time, amount). */
function isPhoneSep(ch: string): boolean {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "-" ||
    ch === "." ||
    ch === "(" ||
    ch === ")" ||
    ch === "－" ||
    ch === "ー" ||
    ch === "−" ||
    ch === "‐" ||
    ch === "（" ||
    ch === "）"
  );
}

function digits(value: string | null | undefined): string {
  if (!value) return "";
  let out = "";
  for (const ch of value) {
    const d = halfWidthDigit(ch);
    if (d) out += d;
  }
  return out;
}

/** Domestic 10–11 digits, or 81 + 9–10 digits. */
function isMaskablePhoneDigits(d: string): boolean {
  if (d.startsWith("81") && (d.length === 11 || d.length === 12)) return true;
  return d.length === 10 || d.length === 11;
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

/**
 * Replace phone-like spans with last-4. Covers +81, fullwidth, spaces/dots/parens,
 * and numbers that differ from the parsed 電話番号. Dates, amounts, and times
 * are left alone (slash/colon/comma are not separators; digit threshold is
 * 10–11 domestic or 81 + 9–10). `phone` is unused for matching (kept for callers).
 */
export function redactPhoneInText(
  text: string | null | undefined,
  phone?: string | null
): string | null {
  if (text === null || text === undefined) return null;
  let out = maskPhoneLikeSpans(text);
  const parsed = digits(phone);
  if (phone && isMaskablePhoneDigits(parsed)) {
    const last4 = parsed.slice(-4);
    const formatted = phone.trim();
    if (formatted && formatted !== last4) out = out.split(formatted).join(last4);
  }
  return out;
}

function findPhoneStart(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "+" || isDigitChar(ch)) return i;
    if ((ch === "(" || ch === "（") && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "+" || isDigitChar(next)) return i;
    }
  }
  return -1;
}

function lastDigitEndOfSpan(text: string, start: number): number {
  let i = start;
  if (text[i] === "(" || text[i] === "（") i += 1;
  if (i < text.length && text[i] === "+") i += 1;
  let lastDigitEnd = i;
  while (i < text.length) {
    if (isDigitChar(text[i])) {
      i += 1;
      lastDigitEnd = i;
      continue;
    }
    if (isPhoneSep(text[i])) {
      if (text[i] === " " || text[i] === "\t") {
        const soFar = digits(text.slice(start, lastDigitEnd));
        if (isMaskablePhoneDigits(soFar)) return lastDigitEnd;
      }
      i += 1;
      continue;
    }
    break;
  }
  return lastDigitEnd;
}

function maskPhoneLikeSpans(text: string): string {
  const hits: Array<{ start: number; end: number; last4: string }> = [];
  let i = 0;
  while (i < text.length) {
    const start = findPhoneStart(text, i);
    if (start < 0) break;
    const end = lastDigitEndOfSpan(text, start);
    if (end <= start) {
      i = start + 1;
      continue;
    }
    const d = digits(text.slice(start, end));
    if (isMaskablePhoneDigits(d)) {
      hits.push({ start, end, last4: d.slice(-4) });
      i = end;
    } else {
      i = start + 1;
    }
  }
  if (hits.length === 0) return text;
  let out = "";
  let cur = 0;
  for (const hit of hits) {
    out += text.slice(cur, hit.start) + hit.last4;
    cur = hit.end;
  }
  return out + text.slice(cur);
}
