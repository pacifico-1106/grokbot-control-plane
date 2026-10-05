/**
 * P0-A Secret-in-chat detector
 * Detects and rejects/redacts secrets in gateway invoke and approval request bodies.
 * Fail-closed: secrets never pass through to chat surfaces.
 * 
 * Locked rules (2026-09-22):
 * - Chat OK: short-lived setup links, approval cards, status/nextStepJa
 * - Chat NEVER: passwords, refresh tokens, API keys, full employee/admin badge secrets
 * - Prefix-only OK for ops triage of Staffpass-issued credentials (secretPrefix);
 *   detector rejections return NO characters of the matched value (2026-10-05)
 *
 * P1 Extension (2026-09-23):
 * - Card-like / PAN-ish patterns added for external contract card registration
 * - On detection: log only that something was blocked (NEVER the matched value)
 * - Fail-closed: card_like_string_blocked audit event
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

/**
 * 2026-10-05 (稲盛 #icebox weekly report false positive, 10:27 JST):
 * - No character of a matched value is ever returned, logged or audited.
 *   `redactedPreview` is kept for compatibility but is a constant.
 * - Allowed metadata: pattern name, field path (identifier keys only), length.
 */
export const SECRET_REDACTED_PREVIEW = '[redacted]';
export const SECRET_DETECTION_NEXT_STEP_JA =
  '該当箇所を外すか伏せて再送してください。誤検知と思われる場合は管理者に連絡してください。';

/** A non-blocking "looks like a key but has no context" hit. No value. */
export type SecretFinding = { pattern: string; fieldPath: string; length: number };

export type SecretDetectionResult = {
  ok: true;
  /** Present only when non-empty. Never carries the value. */
  suspected?: SecretFinding[];
} | {
  ok: false;
  code: 'secret_detected_in_payload';
  pattern: string;
  /** Constant (SECRET_REDACTED_PREVIEW / [CARD_DATA_REDACTED]); never value characters. */
  redactedPreview: string;
  /** Where the value was found (e.g. "args.message"); non-identifier keys become "[key]". */
  fieldPath: string;
  /** Character count of the match. */
  matchLength: number;
  messageJa: string;
  nextStepJa: string;
};

export type SecretScanContext = {
  /** An AKIA/ASIA access key id appears somewhere in the same payload. */
  hasAwsAccessKeyId?: boolean;
  /** Field path of the value (its key names count as AWS keyword context). */
  fieldPath?: string;
};

export type SecretPattern = {
  name: string;
  pattern: RegExp;
  minLength?: number;
};

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'slack_token', pattern: /xox[abcprs]-[0-9A-Za-z\-]+/i },
  { name: 'slack_webhook', pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/i },
  // Left boundary: 'risk-assessment2026…' / 'task-…' are words, not keys.
  { name: 'openai_key', pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/i },
  { name: 'openai_proj', pattern: /(?<![A-Za-z0-9])sk-proj-[A-Za-z0-9_\-]{20,}/i },
  { name: 'staffpass_employee', pattern: /gb_emp_[a-f0-9]{16}_[a-f0-9]{32}/i },
  { name: 'staffpass_admin', pattern: /gb_adm_[a-f0-9]{16}_[a-f0-9]{32}/i },
  { name: 'stripe_key', pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/i },
  { name: 'stripe_restricted', pattern: /rk_(?:live|test)_[A-Za-z0-9]{24,}/i },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/i },
  { name: 'github_classic', pattern: /ghp_[A-Za-z0-9]{36,}/i },
  // Real access key ids are upper-case; ASIA = temporary (STS) credentials.
  { name: 'aws_access_key', pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/ },
  // Evaluated by detectAwsSecretKey (boundary + mixed + context), not by this regex alone.
  { name: 'aws_secret_key', pattern: /[A-Za-z0-9\/+]{40}/, minLength: 40 },
  { name: 'google_api_key', pattern: /AIza[A-Za-z0-9_\-]{35}/i },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/i },
  { name: 'jwt_token', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i },
  // At least one separator (':' '=' quote or space): 'refresh_token_rotation_…' / 'apiKeyRotation…' are identifiers.
  { name: 'refresh_token', pattern: /refresh[_-]?token['":\s=]+[A-Za-z0-9_\-\.]{20,}/i },
  { name: 'api_key_inline', pattern: /api[_-]?key['":\s=]+[A-Za-z0-9_\-]{20,}/i },
  { name: 'password_inline', pattern: /password['":\s]+[^\s'"]{8,}/i },
  { name: 'secret_inline', pattern: /secret['":\s]+[A-Za-z0-9_\-]{16,}/i },
  { name: 'private_key_header', pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i },
  { name: 'base64_long_secret', pattern: /[A-Za-z0-9+\/]{64,}={0,2}/, minLength: 64 },
  { name: 'hex_long_secret', pattern: /[a-f0-9]{64,}/i, minLength: 64 },
];

/**
 * P1 Card-like / PAN-ish patterns for external contract card registration.
 * CRITICAL: On detection, NEVER log the matched value itself.
 * Log only that something was blocked (card_like_string_blocked).
 *
 * Patterns detect potential credit card numbers:
 * - Visa: starts with 4, 13 or 16 digits
 * - Mastercard: starts with 51-55, 16 digits
 * - Amex: starts with 34/37, 15 digits
 * - Generic: 13-19 digit sequences with optional separators
 *
 * All patterns require Luhn checksum validation to reduce false positives.
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */
export type CardLikePattern = {
  name: string;
  pattern: RegExp;
  requiresLuhn: boolean;
};

const CARD_LIKE_PATTERNS: CardLikePattern[] = [
  { name: 'card_visa', pattern: /4[0-9]{12}(?:[0-9]{3})?/, requiresLuhn: true },
  { name: 'card_mastercard', pattern: /5[1-5][0-9]{14}/, requiresLuhn: true },
  { name: 'card_amex', pattern: /3[47][0-9]{13}/, requiresLuhn: true },
  { name: 'card_discover', pattern: /6(?:011|5[0-9]{2})[0-9]{12}/, requiresLuhn: true },
  { name: 'card_jcb', pattern: /(?:2131|1800|35\d{3})\d{11}/, requiresLuhn: true },
  { name: 'card_generic_16', pattern: /[0-9]{4}[\s\-]?[0-9]{4}[\s\-]?[0-9]{4}[\s\-]?[0-9]{4}/, requiresLuhn: true },
  { name: 'card_generic_15', pattern: /[0-9]{4}[\s\-]?[0-9]{6}[\s\-]?[0-9]{5}/, requiresLuhn: true },
];

/**
 * Luhn algorithm (mod 10) checksum validator.
 * Used to validate potential card numbers and reduce false positives.
 * Returns true if the number passes the Luhn check.
 */
function passesLuhnCheck(digits: string): boolean {
  const cleaned = digits.replace(/[\s\-]/g, '');
  if (!/^\d+$/.test(cleaned) || cleaned.length < 13 || cleaned.length > 19) {
    return false;
  }

  let sum = 0;
  let isEven = false;

  for (let i = cleaned.length - 1; i >= 0; i--) {
    let digit = parseInt(cleaned[i], 10);

    if (isEven) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

/**
 * Check if a string contains card-like / PAN-ish patterns.
 * CRITICAL: On detection, return only pattern name for audit.
 * NEVER return or log the matched card number itself.
 */
export type CardLikeDetectionResult = {
  detected: false;
} | {
  detected: true;
  patternName: string;
};

export function detectCardLikeString(value: string): CardLikeDetectionResult {
  const card = cardLikeMatch(value);
  return card ? { detected: true, patternName: card.patternName } : { detected: false };
}

// Whole-value allowlist: values that can never contain a secret.
// (2026-10-05: `^https?://` removed from here. A value that merely STARTS with
// a URL used to skip every pattern, so keys in query strings / after the URL
// were never scanned. Bare URLs now go through the named patterns and the AWS
// rule; see isBareUrl for the generic length-only patterns.)
const ALLOWLIST_PATTERNS = [
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}$/i,
  /^\d{4}-\d{2}-\d{2}/,
  /^[A-Z0-9]{2,10}$/,
];

function isAllowlisted(value: string): boolean {
  return ALLOWLIST_PATTERNS.some(pattern => pattern.test(value.trim()));
}

/**
 * A value that is exactly one URL. The generic length-only patterns
 * (base64_long_secret / hex_long_secret / card numbers) keep their previous
 * behaviour of not scanning these: Staffpass setup / status links carry long
 * signed tokens in their query and are allowed in chat (locked rule 2026-09-22).
 * Named patterns (xox*, sk-, AKIA/ASIA, gb_emp_ …) and aws_secret_key DO scan them.
 */
function isBareUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/** host + path of a URL (scheme optional); group 1 = the path. Query / fragment excluded. */
const URL_PATH_SPAN = /(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(\/[^\s?#"'<>]*)/g;

/**
 * For the generic length-only patterns: inside a URL path '/' is a separator,
 * not base64 data, so 'jp/press/article/…' is not one long token. Query strings
 * and fragments are left untouched (still scanned).
 */
function splitUrlPaths(value: string): string {
  return value.replace(URL_PATH_SPAN, (m: string, path: string) =>
    m.slice(0, m.length - path.length) + path.replace(/\//g, ' ')
  );
}

// ---------------------------------------------------------------------------
// aws_secret_key (2026-10-05). The bare /[A-Za-z0-9\/+=]{40}/ matched any URL
// path or document id with 40 chars in a row. A 40-char candidate now blocks
// only when ALL of these hold:
// - boundary: a maximal run of exactly 40 [A-Za-z0-9/+] — no adjacent
//   [A-Za-z0-9/+_-] on the left and no adjacent [A-Za-z0-9/+=_-] on the right
//   ('=' on the left is an assignment: `key=…` in query strings / .env files);
// - mixed: contains an upper-case letter, a lower-case letter and a digit;
// - context: (a) an AKIA/ASIA access key id anywhere in the same payload, or
//   (b) an AWS secret keyword (`aws…secret`, `secret…access…key`, case-
//   insensitive, `_`/`-`/`.`/space between words) within
//   AWS_KEYWORD_WINDOW_BEFORE chars before or AWS_KEYWORD_WINDOW_AFTER chars
//   after it in the same string, or in its field path (e.g. `SecretAccessKey`).
// Boundary + mixed without context → not blocked, reported as `suspected`.
// Percent-encoded '/', '+', '=' (%2F %2B %3D) are decoded first so a key in a
// URL query string is still caught.
// ---------------------------------------------------------------------------
export const AWS_KEYWORD_WINDOW_BEFORE = 100;
export const AWS_KEYWORD_WINDOW_AFTER = 30;
const AWS_SECRET_CANDIDATE = /(?<![A-Za-z0-9\/+_-])[A-Za-z0-9\/+]{40}(?![A-Za-z0-9\/+=_-])/g;
const AWS_SECRET_KEYWORD = /aws[\s_.-]*secret|secret[\s_.-]*access[\s_.-]*key/i;
const AWS_ACCESS_KEY_ID = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/;

function decodeKeyChars(value: string): string {
  return value.replace(/%2F/gi, '/').replace(/%2B/gi, '+').replace(/%3D/gi, '=');
}

function isMixedCharset(value: string): boolean {
  return /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value);
}

export function hasAwsAccessKeyId(value: string): boolean {
  return AWS_ACCESS_KEY_ID.test(decodeKeyChars(value));
}

function detectAwsSecretKey(
  value: string,
  ctx: SecretScanContext
): { kind: 'block' | 'suspect'; length: number } | null {
  const text = decodeKeyChars(value);
  let suspect: { kind: 'suspect'; length: number } | null = null;
  const pathHasKeyword = AWS_SECRET_KEYWORD.test(ctx.fieldPath ?? '');
  const idInPayload = ctx.hasAwsAccessKeyId === true || AWS_ACCESS_KEY_ID.test(text);
  for (const m of text.matchAll(AWS_SECRET_CANDIDATE)) {
    const candidate = m[0];
    if (!isMixedCharset(candidate)) continue;
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - AWS_KEYWORD_WINDOW_BEFORE), start);
    const after = text.slice(start + candidate.length, start + candidate.length + AWS_KEYWORD_WINDOW_AFTER);
    if (idInPayload || pathHasKeyword || AWS_SECRET_KEYWORD.test(before) || AWS_SECRET_KEYWORD.test(after)) {
      return { kind: 'block', length: candidate.length };
    }
    suspect = { kind: 'suspect', length: candidate.length };
  }
  return suspect;
}

// ---------------------------------------------------------------------------

type StringAtPath = { path: string; value: string };

/** Field path segment: only short identifier keys that are not themselves secret-like. */
function safeKeySegment(key: string): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,39}$/.test(key)) return '[key]';
  if (SECRET_PATTERNS.some(({ name, pattern }) => name !== 'aws_secret_key' && pattern.test(key))) return '[key]';
  if (key.length >= 16 && isMixedCharset(key)) return '[key]';
  return key;
}

function extractAllStrings(obj: unknown, path: string = '', depth: number = 0, maxDepth: number = 10): StringAtPath[] {
  if (depth > maxDepth) return [];
  if (typeof obj === 'string') return [{ path, value: obj }];
  if (Array.isArray(obj)) {
    return obj.flatMap((item, i) => extractAllStrings(item, `${path}[${i}]`, depth + 1, maxDepth));
  }
  if (obj && typeof obj === 'object') {
    return Object.entries(obj).flatMap(([key, value]) => {
      const seg = safeKeySegment(key);
      return extractAllStrings(value, path ? `${path}.${seg}` : seg, depth + 1, maxDepth);
    });
  }
  return [];
}

function blockedResult(name: string, fieldPath: string, matchLength: number): SecretDetectionResult & { ok: false } {
  return {
    ok: false,
    code: 'secret_detected_in_payload',
    pattern: name,
    redactedPreview: SECRET_REDACTED_PREVIEW,
    fieldPath,
    matchLength,
    messageJa: `ペイロードに秘密情報（${name}）が検出されました。チャットにシークレットを含めないでください。`,
    nextStepJa: 'Staffpassホスト画面でセットアップを行ってください。設定URLは setup.slackStatus / setup.lineApprovalStatus / setup.connectInternalBase の nextStepJa で取得できます。',
  };
}

function cardLikeMatch(value: string): { patternName: string; length: number } | null {
  for (const { name, pattern, requiresLuhn } of CARD_LIKE_PATTERNS) {
    const match = value.match(pattern);
    if (match) {
      if (requiresLuhn && !passesLuhnCheck(match[0])) continue;
      return { patternName: name, length: match[0].length };
    }
  }
  return null;
}

export function detectSecretInString(value: string, ctx: SecretScanContext = {}): SecretDetectionResult {
  if (isAllowlisted(value)) return { ok: true };
  const fieldPath = (ctx.fieldPath ?? '').slice(0, 200);
  const bareUrl = isBareUrl(value);
  let genericText: string | null = null;
  const suspected: SecretFinding[] = [];

  for (const { name, pattern, minLength } of SECRET_PATTERNS) {
    if (name === 'aws_secret_key') {
      const aws = detectAwsSecretKey(value, ctx);
      if (aws?.kind === 'block') return blockedResult(name, fieldPath, aws.length);
      if (aws?.kind === 'suspect') suspected.push({ pattern: name, fieldPath, length: aws.length });
      continue;
    }
    const isGeneric = name === 'base64_long_secret' || name === 'hex_long_secret';
    if (isGeneric && bareUrl) continue;
    if (isGeneric && genericText === null) genericText = splitUrlPaths(value);
    const match = (isGeneric ? (genericText as string) : value).match(pattern);
    if (match) {
      const matched = match[0];
      if (minLength && matched.length < minLength) continue;
      if (isGeneric) {
        if (isAllowlisted(matched)) continue;
        if (/^[a-f0-9]+$/i.test(matched) && matched.length < 64) continue;
      }
      return blockedResult(name, fieldPath, matched.length);
    }
  }

  if (!bareUrl) {
    const card = cardLikeMatch(value);
    if (card) {
      return {
        ok: false,
        code: 'secret_detected_in_payload',
        pattern: card.patternName,
        redactedPreview: '[CARD_DATA_REDACTED]',
        fieldPath,
        matchLength: card.length,
        messageJa: 'カード情報のような文字列が検出されました。カード番号をチャットに入力しないでください。',
        nextStepJa: 'カード登録はStaffpassから発行されるセキュアリンクを使用してください。Stripeのホスト画面で安全にカード情報を入力できます。',
      };
    }
  }

  return suspected.length > 0 ? { ok: true, suspected } : { ok: true };
}

export function detectSecretInPayload(payload: unknown): SecretDetectionResult {
  const strings = extractAllStrings(payload);
  const idInPayload = strings.some(({ value }) => hasAwsAccessKeyId(value));
  const suspected: SecretFinding[] = [];
  for (const { path, value } of strings) {
    const result = detectSecretInString(value, { hasAwsAccessKeyId: idInPayload, fieldPath: path });
    if (!result.ok) return result;
    if (result.suspected) suspected.push(...result.suspected);
  }
  return suspected.length > 0 ? { ok: true, suspected } : { ok: true };
}

export type AuditSafePayload = {
  safe: true;
  payload: Record<string, unknown>;
} | {
  safe: false;
  pattern: string;
  redactedPreview: string;
};

export function redactPayloadForAudit(payload: Record<string, unknown>): AuditSafePayload {
  const detection = detectSecretInPayload(payload);
  if (detection.ok) {
    return { safe: true, payload };
  }
  return {
    safe: false,
    pattern: detection.pattern,
    redactedPreview: constantPreview(detection.pattern),
  };
}

const SETUP_DEEP_LINK_MESSAGE_JA = 'チャットでシークレットを送信しないでください。セットアップは Staffpass のホスト画面で行ってください。';
const SETUP_DEEP_LINK_NEXTSTEP_JA = 'Admin MCP の setup.slackStatus、setup.lineApprovalStatus、または setup.connectInternalBase を呼び出してセットアップURLを取得してください。SlackやLINEでリンクを開き、Staffpassホスト画面で認証を完了してください。';

/** Constant preview: never characters of the value, whatever the caller passed in. */
function constantPreview(pattern: string): string {
  return pattern.startsWith('card_') ? '[CARD_DATA_REDACTED]' : SECRET_REDACTED_PREVIEW;
}

/**
 * Rejection body. Existing fields kept; 2026-10-05 adds `nextStep` (generic,
 * for the AI), `retryable: false` (the same payload is rejected again),
 * `fieldPath` and `matchLength`. Never any characters of the value.
 */
export function buildSecretDetectionErrorResponse(detection: SecretDetectionResult & { ok: false }): {
  ok: false;
  code: "secret_detected_in_payload";
  error: "secret_detected_in_payload";
  pattern: string;
  redactedPreview: string;
  fieldPath: string;
  matchLength: number;
  messageJa: string;
  nextStepJa: string;
  nextStep: string;
  retryable: false;
} {
  return {
    ok: false,
    code: detection.code,
    error: detection.code,
    pattern: detection.pattern,
    redactedPreview: constantPreview(detection.pattern),
    fieldPath: detection.fieldPath,
    matchLength: detection.matchLength,
    messageJa: SETUP_DEEP_LINK_MESSAGE_JA,
    nextStepJa: SETUP_DEEP_LINK_NEXTSTEP_JA,
    nextStep: SECRET_DETECTION_NEXT_STEP_JA,
    retryable: false,
  };
}

/**
 * P1: Check if a detection result is for card-like patterns.
 * Used to trigger card_like_string_blocked audit events.
 */
export function isCardLikeDetection(detection: SecretDetectionResult): boolean {
  if (detection.ok) return false;
  return detection.pattern.startsWith('card_');
}

/**
 * P1: Build card-specific error response with stricter redaction.
 * CRITICAL: redactedPreview is always [CARD_DATA_REDACTED] — never any card digits.
 */
const CARD_SETUP_MESSAGE_JA = 'カード情報のような文字列が検出されました。カード番号をチャットに入力しないでください。';
const CARD_SETUP_NEXTSTEP_JA = 'カード登録はStaffpassから発行されるセキュアリンクを使用してください。Stripeのホスト画面で安全にカード情報を入力できます。';

export function buildCardDetectionErrorResponse(detection: SecretDetectionResult & { ok: false }): {
  ok: false;
  code: "secret_detected_in_payload";
  error: "card_like_string_blocked";
  pattern: string;
  redactedPreview: "[CARD_DATA_REDACTED]";
  messageJa: string;
  nextStepJa: string;
} {
  return {
    ok: false,
    code: detection.code,
    error: "card_like_string_blocked",
    pattern: detection.pattern,
    redactedPreview: "[CARD_DATA_REDACTED]",
    messageJa: CARD_SETUP_MESSAGE_JA,
    nextStepJa: CARD_SETUP_NEXTSTEP_JA,
  };
}
