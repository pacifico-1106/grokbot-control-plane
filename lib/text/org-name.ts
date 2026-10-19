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
//   - javascript:, vbscript:, mailto: are checked on whitespace-stripped string
//   - data:, file: only rejected when not separated by space (common words)
// - www. (checked on whitespace-stripped string)
// - xn-- (punycode)
// - @ (email-like)
// - / or // (path-like) - includes slash-like Unicode characters
// - Host with port (domain.tld:port, IPv4:port, IPv6:port)
//
// Allow:
// - Names with only dots (Sealith.AI, example.com, 1.2.3.4 without port)
// - Time/ratio patterns like "10:30", "16:9"

// Slash-like characters to normalize to /
// U+2215 DIVISION SLASH (∕)
// U+2044 FRACTION SLASH (⁄)
// U+29F8 BIG SOLIDUS (⧸)
// U+2571 BOX DRAWINGS LIGHT DIAGONAL UPPER RIGHT TO LOWER LEFT (╱)
// U+FF0F FULLWIDTH SOLIDUS (／)
// Note: U+FE68 SMALL REVERSE SOLIDUS is a backslash, not a slash - excluded
const SLASH_LIKE_CHARS = /[\u2215\u2044\u29f8\u2571\uff0f]/g;

// URL scheme patterns (case insensitive)
// For non-whitespace-stripped check (data: and file: only without space)
const URL_SCHEME_PATTERN = /(?:https?|hxxps?|ftp|javascript|data|vbscript|file|mailto):/i;

// Schemes that require :// (for whitespace-stripped detection)
const URL_SCHEME_WITH_SLASHES = /(?:https?|hxxps?|ftp):\/\//i;

// Dangerous schemes that should be rejected even with whitespace
// These are checked on whitespace-stripped, lowercased string
const DANGEROUS_SCHEME_NO_SPACE = /(?:javascript|vbscript|mailto):/i;

// Scheme with space/NBSP before colon (e.g., "http ://")
const URL_SCHEME_SPACED_PATTERN = /(?:https?|hxxps?|ftp)[\s\u00a0]*:[\s\u00a0]*\/\//i;

// www. prefix - checked on whitespace-stripped string
const WWW_PATTERN = /www\./i;

// Punycode label pattern (xn--) - reject
const PUNYCODE_PATTERN = /(?:^|[\s.])xn--[a-z0-9-]*/i;

// @ sign (email-like) - reject
const AT_SIGN_PATTERN = /@/;

// Slash pattern (path-like) - reject (after normalizing slash-like chars)
const SLASH_PATTERN = /\//;

// Host with port pattern - reject
// Host is one of:
// - Domain/IPv4: labels with at least one dot (e.g., a.com, 1.2.3.4)
// - IPv6 in brackets: [::1], [2001:db8::1]
// - Bare IPv6 with :: (e.g., ::1, fe80::1:443) - MUST contain ::
// Port: colon + optional space + 1-5 digits + (end or any non-digit)
// Host can be preceded by: start, space, or non-ASCII (Japanese)
// 
// LOW-2: Port followed by non-digit (letter, dot, etc.) is rejected for domain/IPv6
// Examples: a.com:8080foo, evil.com:8080. → rejected
// Time/ratio patterns without dots (10:30, 16:9) → allowed (not matched by these patterns)
const HOST_PORT_DOMAIN_IPV4 = /(?:^|[\s\u3000-\u9fff\uac00-\ud7af])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?:\s?\d{1,5}(?:$|[^0-9])/i;
const HOST_PORT_IPV6_BRACKET = /\[[0-9a-f:]+\]:\s?\d{1,5}(?:$|[^0-9])/i;
// LOW-1: Only match IPv6 addresses containing :: (not aa:bb:cc:80 which has no ::)
const HOST_PORT_IPV6_BARE = /(?:^|[\s])(?:[0-9a-f]*::)[0-9a-f:]*:\s?\d{1,5}(?:$|[^0-9])/i;

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
 * - Replace slash-like characters with ASCII /
 * - Replace fullwidth characters with ASCII equivalents
 * - Replace ideographic full stop (。U+3002) with dot
 * - Strip combining characters (they don't affect URL detection, e.g., café is allowed)
 */
function normalizeForUrlCheck(s: string): string {
  return s
    // Slash-like characters → /
    .replace(SLASH_LIKE_CHARS, "/")
    // Fullwidth colon (：) → :
    .replace(/\uff1a/g, ":")
    // Fullwidth full stop (．) → .
    .replace(/\uff0e/g, ".")
    // Ideographic full stop (。) → .
    .replace(/\u3002/g, ".")
    // Fullwidth letters A-Z, a-z → ASCII
    .replace(/[\uff21-\uff3a]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\uff41-\uff5a]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // Fullwidth digits 0-9 → ASCII
    .replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // Strip combining characters (café with combining acute is allowed)
    .replace(COMBINING_CHARS, "");
}

/**
 * Check if a string looks like it contains a URL-like pattern.
 *
 * All checks are performed on NFKC-normalized, then URL-normalized string.
 * Some checks use whitespace-stripped, lowercased version.
 *
 * Reject: schemes, www., xn--, @, /, //, host:port
 * Allow: names with only dots (Sealith.AI, example.com, 1.2.3.4 without port)
 *        time/ratio patterns (10:30, 16:9)
 */
function containsUrlLike(s: string): boolean {
  // Normalize for URL detection (slash-like → /, fullwidth → ASCII, strip combining)
  const normalized = normalizeForUrlCheck(s);
  
  // Whitespace-stripped and lowercased for scheme/www checks
  const noWhitespace = normalized.replace(/\s+/g, "").toLowerCase();

  // 1. Check dangerous schemes on whitespace-stripped string
  //    javascript:, vbscript:, mailto: are dangerous even with spaces
  if (DANGEROUS_SCHEME_NO_SPACE.test(noWhitespace)) return true;

  // 2. Check scheme with :// on whitespace-stripped string (ht tp://, h t t p s://)
  if (URL_SCHEME_WITH_SLASHES.test(noWhitespace)) return true;

  // 3. Check www. on whitespace-stripped string (w w w.evil)
  if (WWW_PATTERN.test(noWhitespace)) return true;

  // 4. Check explicit schemes without space separation
  //    data: and file: are common words, only reject when directly followed by content
  //    "File: Notes" is rejected, "File : Notes" is allowed
  if (URL_SCHEME_PATTERN.test(normalized)) return true;

  // 5. Check scheme with space/NBSP before colon (e.g., "http ://")
  if (URL_SCHEME_SPACED_PATTERN.test(normalized)) return true;

  // 6. Check punycode labels (xn--)
  if (PUNYCODE_PATTERN.test(normalized)) return true;

  // 7. Check @ sign (email-like)
  if (AT_SIGN_PATTERN.test(normalized)) return true;

  // 8. Check slash (path-like) - after slash-like normalization
  if (SLASH_PATTERN.test(normalized)) return true;

  // 9. Check host with port patterns
  //    Only reject when host is domain/IPv4/IPv6, not digit:digit patterns
  if (HOST_PORT_DOMAIN_IPV4.test(normalized)) return true;
  if (HOST_PORT_IPV6_BRACKET.test(normalized)) return true;
  if (HOST_PORT_IPV6_BARE.test(normalized)) return true;

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
