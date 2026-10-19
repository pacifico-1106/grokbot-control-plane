/**
 * lib/text/org-name.ts
 * Shared org name validation and text sanitization helpers.
 *
 * ORG_NAME_INPUT_STRICT_ENABLED (default OFF):
 * - When ON: reject bidi / zero-width / invisible / control / URL-like strings at input
 * - When OFF: existing behavior preserved (base validation only)
 *
 * sanitizeTextForMail: used by email templates and LP inquiry forms to strip
 * dangerous characters before rendering. Always active (not flag-gated) since
 * it sanitizes OUTPUT, making mail safer.
 */

import { isOrgNameInputStrictEnabled } from "@/lib/feature-flags";

export const ORG_NAME_MAX_LENGTH = 100;
export const ORG_NAME_MAX_LENGTH_ADMIN = 200;

/**
 * Count code points in a string (handles surrogate pairs correctly).
 * JavaScript string.length counts UTF-16 code units, not code points.
 * Example: "𠮷" (U+20BB7) has length=2 but 1 code point.
 */
export function countCodePoints(s: string): number {
  return [...s].length;
}

// Control characters: U+0000–001F, U+007F–009F, U+2028, U+2029
// For test(): no /g flag (avoids lastIndex state issues)
// For replace(): use _GLOBAL variant with /g flag
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\r\n]/;
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\r\n]+/g;

// Bidi control characters: U+202A–202E, U+2066–2069, U+200E/F, U+061C
const BIDI_CHARS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/;
const BIDI_CHARS_GLOBAL = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]+/g;

// Zero-width and invisible characters: U+200B–200D, U+2060–2065, U+FEFF, U+00AD, U+180E
// Note: U+2061–2065 are function application / invisible operators
const INVISIBLE_CHARS = /[\u200b-\u200d\u2060-\u2065\ufeff\u00ad\u180e]/;
const INVISIBLE_CHARS_GLOBAL = /[\u200b-\u200d\u2060-\u2065\ufeff\u00ad\u180e]+/g;

// === URL detection patterns ===
// Simplified rules: reject only specific dangerous patterns, allow dot-only names.
//
// Reject:
// - Schemes (http, https, hxxp, hxxps, ftp, javascript, data, vbscript, file, mailto)
// - www.
// - xn-- (punycode)
// - @ (email-like)
// - / or // (path-like)
// - Host with port (e.g., a.com:8080, 1.2.3.4:80)
//
// Allow:
// - Names with only dots (Sealith.AI, example.com, 1.2.3.4 without port)

// URL scheme patterns (case insensitive)
// Includes obfuscated variants (hxxp, hxxps) and ftp
const URL_SCHEME_PATTERN = /(?:https?|hxxps?|ftp|javascript|data|vbscript|file|mailto):/i;

// Schemes that require :// (for whitespace-stripped detection)
const URL_SCHEME_WITH_SLASHES = /(?:https?|hxxps?|ftp):\/\//i;

// Scheme with space/NBSP before colon (e.g., "http ://")
const URL_SCHEME_SPACED_PATTERN = /(?:https?|hxxps?|ftp)[\s\u00a0]*:[\s\u00a0]*\/\//i;

// www. prefix (reject)
const WWW_PREFIX_PATTERN = /(?:^|[\s])www\./i;

// Punycode label pattern (xn--) - reject
const PUNYCODE_PATTERN = /(?:^|[\s.])xn--[a-z0-9-]*/i;

// @ sign (email-like) - reject
const AT_SIGN_PATTERN = /@/;

// Slash patterns (path-like) - reject
const SLASH_PATTERN = /\//;

// Host with port pattern - reject
// Matches: word.word:digits or digit.digit.digit.digit:digits at word boundaries
// Using \b for word boundary; after NFKC normalization so . and : are ASCII
const HOST_PORT_PATTERN = /(?:^|[\s])(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\d{1,3}(?:\.\d{1,3}){3}):\d+(?:$|[\s])/i;

// Combining character pattern for stripping before URL check
const COMBINING_CHARS = /\p{M}/gu;

type ValidationResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

/**
 * Sanitize text for mail body output.
 * Strips bidi, zero-width, invisible, and control characters.
 * Replaces NBSP (U+00A0) with regular space.
 * Collapses whitespace and caps length.
 * Always active (not flag-gated) — makes mail safer.
 */
export function sanitizeTextForMail(value: unknown, max: number): string {
  return (
    String(value ?? "")
      // Do NOT use NFKC normalization here — it changes display characters
      // NFKC is only used in validation (validateOrgNameStrict)
      // Replace NBSP (U+00A0) with regular space
      // Note: U+3000 (ideographic space) is preserved — commonly used in Japanese company names
      .replace(/\u00a0/g, " ")
      // Strip control chars
      .replace(CONTROL_CHARS_GLOBAL, "")
      // Strip bidi chars
      .replace(BIDI_CHARS_GLOBAL, "")
      // Strip invisible chars (including U+2061–2065, U+061C, U+00AD, U+180E)
      .replace(INVISIBLE_CHARS_GLOBAL, "")
      // Collapse whitespace
      .replace(/[ \t]+/g, " ")
      .trim()
      .slice(0, max)
  );
}

/**
 * Check if a string contains bidi control characters.
 */
function containsBidiChars(s: string): boolean {
  return BIDI_CHARS.test(s);
}

/**
 * Check if a string contains invisible/zero-width characters.
 */
function containsInvisibleChars(s: string): boolean {
  return INVISIBLE_CHARS.test(s);
}

/**
 * Check if a string contains control characters (including CR/LF).
 */
function containsControlChars(s: string): boolean {
  return CONTROL_CHARS.test(s);
}

/**
 * Normalize string for URL detection:
 * - Replace fullwidth characters with ASCII equivalents
 * - Replace ideographic full stop (。U+3002) with dot
 * - Strip combining characters
 */
function normalizeForUrlCheck(s: string): string {
  return s
    // Fullwidth colon (：) → :
    .replace(/\uff1a/g, ":")
    // Fullwidth solidus (／) → /
    .replace(/\uff0f/g, "/")
    // Fullwidth full stop (．) → .
    .replace(/\uff0e/g, ".")
    // Ideographic full stop (。) → .
    .replace(/\u3002/g, ".")
    // Fullwidth letters A-Z, a-z → ASCII
    .replace(/[\uff21-\uff3a]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\uff41-\uff5a]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // Fullwidth digits 0-9 → ASCII
    .replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // Strip combining characters
    .replace(COMBINING_CHARS, "");
}

/**
 * Check if a string looks like it contains a URL-like pattern.
 *
 * Simplified rules (after NFKC normalization):
 * - Reject: schemes, www., xn--, @, /, //, host:port
 * - Allow: names with only dots (Sealith.AI, example.com, 1.2.3.4 without port)
 */
function containsUrlLike(s: string): boolean {
  // Normalize for URL detection (fullwidth → ASCII, 。→ ., strip combining)
  const normalized = normalizeForUrlCheck(s);

  // 1. Check explicit schemes (http, https, hxxp, hxxps, ftp, javascript, data, etc.)
  if (URL_SCHEME_PATTERN.test(normalized)) return true;

  // 2. Check scheme with space/NBSP before colon (e.g., "http ://")
  if (URL_SCHEME_SPACED_PATTERN.test(normalized)) return true;

  // 3. Check scheme with spaces inside (e.g., "ht tp://", "h t t p s://")
  const noWhitespace = normalized.replace(/\s+/g, "");
  if (URL_SCHEME_WITH_SLASHES.test(noWhitespace)) return true;

  // 4. Check www. prefix
  if (WWW_PREFIX_PATTERN.test(normalized)) return true;

  // 5. Check punycode labels (xn--)
  if (PUNYCODE_PATTERN.test(normalized)) return true;

  // 6. Check @ sign (email-like)
  if (AT_SIGN_PATTERN.test(normalized)) return true;

  // 7. Check slash (path-like)
  if (SLASH_PATTERN.test(normalized)) return true;

  // 8. Check host with port (e.g., a.com:8080, 1.2.3.4:80)
  if (HOST_PORT_PATTERN.test(normalized)) return true;

  // All other patterns (including domain-like names with dots) are allowed
  return false;
}

/**
 * Validate org name with strict rules (only when flag is ON).
 * When flag is OFF, performs base validation only.
 *
 * @param raw - The raw org name string to validate
 * @param maxLength - Maximum length (default: ORG_NAME_MAX_LENGTH = 100)
 *                    When flag is ON, uses code point count; when OFF, uses string length.
 *
 * Error messages are in Japanese and do NOT echo the input value.
 */
export function validateOrgNameStrict(
  raw: string,
  maxLength: number = ORG_NAME_MAX_LENGTH
): ValidationResult {
  // Normalize and trim
  const v = (raw || "").normalize("NFKC").trim();

  // Empty check
  if (!v) {
    return { ok: false, message: "会社名を入力してください" };
  }

  // Length check (code points when flag ON, string length when OFF)
  const len = isOrgNameInputStrictEnabled() ? countCodePoints(v) : v.length;
  if (len > maxLength) {
    return {
      ok: false,
      message: `会社名は${maxLength}文字以内で入力してください`,
    };
  }

  // When flag is OFF, return normalized value (base validation only)
  if (!isOrgNameInputStrictEnabled()) {
    // Still strip bidi/invisible for the returned value, but don't reject
    const sanitized = sanitizeTextForMail(v, maxLength);
    return { ok: true, value: sanitized || v };
  }

  // === Flag is ON: strict validation ===

  // Check control characters (including CR/LF)
  if (containsControlChars(v)) {
    return {
      ok: false,
      message: "会社名に制御文字または改行が含まれています",
    };
  }

  // Check bidi characters
  if (containsBidiChars(v)) {
    return {
      ok: false,
      message: "会社名に双方向制御文字が含まれています",
    };
  }

  // Check invisible characters
  if (containsInvisibleChars(v)) {
    return {
      ok: false,
      message: "会社名に不可視文字が含まれています",
    };
  }

  // Check URL-like strings
  if (containsUrlLike(v)) {
    return {
      ok: false,
      message: "会社名にURLのような文字列が含まれています",
    };
  }

  // All checks passed
  return { ok: true, value: v };
}

// Re-export for backward compatibility with lib/lp/inquiry-mail
export { sanitizeTextForMail as sanitizeInquiryPlainText };
