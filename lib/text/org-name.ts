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

// Control characters: U+0000–001F, U+007F–009F, U+2028, U+2029
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\r\n]+/g;

// Bidi control characters: U+202A–202E, U+2066–2069, U+200E/F, U+061C
const BIDI_CHARS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/;
const BIDI_CHARS_GLOBAL = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]+/g;

// Zero-width and invisible characters: U+200B–200D, U+2060, U+FEFF, U+00AD, U+180E
const INVISIBLE_CHARS = /[\u200b-\u200d\u2060\ufeff\u00ad\u180e]/;
const INVISIBLE_CHARS_GLOBAL = /[\u200b-\u200d\u2060\ufeff\u00ad\u180e]+/g;

// URL scheme patterns (case insensitive)
const URL_SCHEME_PATTERN = /(?:https?|javascript|data|vbscript|file|mailto):/i;

// www. prefix
const WWW_PREFIX_PATTERN = /(?:^|\s)www\./i;

// Domain-like pattern: alphanumeric label followed by . and a TLD (2+ letters)
// Must avoid false positives for "Co., Ltd.", "Inc." etc.
// Matches: example.com, evil.co.jp, test.org/path
// Does NOT match: Co., Ltd. (comma after), Inc. (space/end after), 2.0 (number TLD)
// Supports multi-level domains like evil.co.jp
const DOMAIN_PATTERN = /(?:^|[\s(])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}(?:[\/\?#]|$|\s)/i;

// Patterns that indicate NOT a domain (safe company suffixes)
// "Co., Ltd." "Inc." etc. — followed by comma, end, or space with no path-like continuation
const SAFE_SUFFIX_PATTERN = /\b(?:co|inc|ltd|llc|llp|corp|gmbh|sa|ag|plc|kg)\.(?:,|\s|$)/i;

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
      .normalize("NFKC")
      // Replace NBSP with regular space before other processing
      .replace(/\u00a0/g, " ")
      // Strip control chars
      .replace(CONTROL_CHARS, "")
      // Strip bidi chars
      .replace(BIDI_CHARS_GLOBAL, "")
      // Strip invisible chars (including newly added U+061C, U+00AD, U+180E)
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
 * Check if a string looks like it contains a URL.
 * Avoids false positives for "Co., Ltd.", "Inc." etc.
 */
function containsUrlLike(s: string): boolean {
  // Check explicit schemes
  if (URL_SCHEME_PATTERN.test(s)) return true;

  // Check www. prefix
  if (WWW_PREFIX_PATTERN.test(s)) return true;

  // Check domain-like patterns, but exclude safe company suffixes
  // First, check if there's a domain-like pattern
  if (DOMAIN_PATTERN.test(s)) {
    // If the entire match is a safe suffix pattern, it's not a URL
    // We need to check if the domain-like portion is actually a company suffix
    const safeSuffixes = s.match(SAFE_SUFFIX_PATTERN);
    if (safeSuffixes) {
      // Remove safe suffixes and check again
      const withoutSafe = s.replace(SAFE_SUFFIX_PATTERN, " ");
      if (!DOMAIN_PATTERN.test(withoutSafe)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Validate org name with strict rules (only when flag is ON).
 * When flag is OFF, performs base validation only.
 *
 * Error messages are in Japanese and do NOT echo the input value.
 */
export function validateOrgNameStrict(raw: string): ValidationResult {
  // Normalize and trim
  const v = (raw || "").normalize("NFKC").trim();

  // Empty check
  if (!v) {
    return { ok: false, message: "会社名を入力してください" };
  }

  // Length check
  if (v.length > ORG_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `会社名は${ORG_NAME_MAX_LENGTH}文字以内で入力してください`,
    };
  }

  // When flag is OFF, return normalized value (base validation only)
  if (!isOrgNameInputStrictEnabled()) {
    // Still strip bidi/invisible for the returned value, but don't reject
    const sanitized = sanitizeTextForMail(v, ORG_NAME_MAX_LENGTH);
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
