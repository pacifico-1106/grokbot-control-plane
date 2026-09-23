/**
 * P0-A Secret-in-chat detector
 * Detects and rejects/redacts secrets in gateway invoke and approval request bodies.
 * Fail-closed: secrets never pass through to chat surfaces.
 * 
 * Locked rules (2026-09-22):
 * - Chat OK: short-lived setup links, approval cards, status/nextStepJa
 * - Chat NEVER: passwords, refresh tokens, API keys, full employee/admin badge secrets
 * - Prefix-only OK for ops triage
 *
 * P1 Extension (2026-09-23):
 * - Card-like / PAN-ish patterns added for external contract card registration
 * - On detection: log only that something was blocked (NEVER the matched value)
 * - Fail-closed: card_like_string_blocked audit event
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

export type SecretDetectionResult = {
  ok: true;
} | {
  ok: false;
  code: 'secret_detected_in_payload';
  pattern: string;
  redactedPreview: string;
  messageJa: string;
  nextStepJa: string;
};

export type SecretPattern = {
  name: string;
  pattern: RegExp;
  minLength?: number;
};

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'slack_token', pattern: /xox[abcprs]-[0-9A-Za-z\-]+/i },
  { name: 'slack_webhook', pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/i },
  { name: 'openai_key', pattern: /sk-[A-Za-z0-9]{20,}/i },
  { name: 'openai_proj', pattern: /sk-proj-[A-Za-z0-9_\-]{20,}/i },
  { name: 'staffpass_employee', pattern: /gb_emp_[a-f0-9]{16}_[a-f0-9]{32}/i },
  { name: 'staffpass_admin', pattern: /gb_adm_[a-f0-9]{16}_[a-f0-9]{32}/i },
  { name: 'stripe_key', pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/i },
  { name: 'stripe_restricted', pattern: /rk_(?:live|test)_[A-Za-z0-9]{24,}/i },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/i },
  { name: 'github_classic', pattern: /ghp_[A-Za-z0-9]{36,}/i },
  { name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/i },
  { name: 'aws_secret_key', pattern: /[A-Za-z0-9\/+=]{40}/, minLength: 40 },
  { name: 'google_api_key', pattern: /AIza[A-Za-z0-9_\-]{35}/i },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/i },
  { name: 'jwt_token', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i },
  { name: 'refresh_token', pattern: /refresh[_-]?token['":\s]*[A-Za-z0-9_\-\.]{20,}/i },
  { name: 'api_key_inline', pattern: /api[_-]?key['":\s]*[A-Za-z0-9_\-]{20,}/i },
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
  for (const { name, pattern, requiresLuhn } of CARD_LIKE_PATTERNS) {
    const match = value.match(pattern);
    if (match) {
      const matched = match[0];
      if (requiresLuhn && !passesLuhnCheck(matched)) {
        continue;
      }
      return {
        detected: true,
        patternName: name,
      };
    }
  }
  return { detected: false };
}

const ALLOWLIST_PATTERNS = [
  /^https?:\/\//i,
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}$/i,
  /^\d{4}-\d{2}-\d{2}/,
  /^[A-Z0-9]{2,10}$/,
];

function isAllowlisted(value: string): boolean {
  return ALLOWLIST_PATTERNS.some(pattern => pattern.test(value.trim()));
}

function redactSecret(value: string, maxPrefix: number = 8): string {
  if (value.length <= maxPrefix + 3) return '***';
  return value.slice(0, maxPrefix) + '***';
}

function extractAllStrings(obj: unknown, depth: number = 0, maxDepth: number = 10): string[] {
  if (depth > maxDepth) return [];
  if (typeof obj === 'string') return [obj];
  if (Array.isArray(obj)) {
    return obj.flatMap(item => extractAllStrings(item, depth + 1, maxDepth));
  }
  if (obj && typeof obj === 'object') {
    return Object.values(obj).flatMap(value => extractAllStrings(value, depth + 1, maxDepth));
  }
  return [];
}

export function detectSecretInString(value: string): SecretDetectionResult {
  if (isAllowlisted(value)) return { ok: true };

  for (const { name, pattern, minLength } of SECRET_PATTERNS) {
    const match = value.match(pattern);
    if (match) {
      const matched = match[0];
      if (minLength && matched.length < minLength) continue;
      if (name === 'base64_long_secret' || name === 'hex_long_secret') {
        if (isAllowlisted(matched)) continue;
        if (/^[a-f0-9]+$/i.test(matched) && matched.length < 64) continue;
      }
      return {
        ok: false,
        code: 'secret_detected_in_payload',
        pattern: name,
        redactedPreview: redactSecret(matched),
        messageJa: `ペイロードに秘密情報（${name}）が検出されました。チャットにシークレットを含めないでください。`,
        nextStepJa: 'Staffpassホスト画面でセットアップを行ってください。設定URLは setup.slackStatus / setup.lineApprovalStatus / setup.connectInternalBase の nextStepJa で取得できます。',
      };
    }
  }

  const cardResult = detectCardLikeString(value);
  if (cardResult.detected) {
    return {
      ok: false,
      code: 'secret_detected_in_payload',
      pattern: cardResult.patternName,
      redactedPreview: '[CARD_DATA_REDACTED]',
      messageJa: 'カード情報のような文字列が検出されました。カード番号をチャットに入力しないでください。',
      nextStepJa: 'カード登録はStaffpassから発行されるセキュアリンクを使用してください。Stripeのホスト画面で安全にカード情報を入力できます。',
    };
  }

  return { ok: true };
}

export function detectSecretInPayload(payload: unknown): SecretDetectionResult {
  const strings = extractAllStrings(payload);
  for (const str of strings) {
    const result = detectSecretInString(str);
    if (!result.ok) return result;
  }
  return { ok: true };
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
    redactedPreview: detection.redactedPreview,
  };
}

const SETUP_DEEP_LINK_MESSAGE_JA = 'チャットでシークレットを送信しないでください。セットアップは Staffpass のホスト画面で行ってください。';
const SETUP_DEEP_LINK_NEXTSTEP_JA = 'Admin MCP の setup.slackStatus、setup.lineApprovalStatus、または setup.connectInternalBase を呼び出してセットアップURLを取得してください。SlackやLINEでリンクを開き、Staffpassホスト画面で認証を完了してください。';

export function buildSecretDetectionErrorResponse(detection: SecretDetectionResult & { ok: false }): {
  ok: false;
  code: "secret_detected_in_payload";
  error: "secret_detected_in_payload";
  pattern: string;
  redactedPreview: string;
  messageJa: string;
  nextStepJa: string;
} {
  return {
    ok: false,
    code: detection.code,
    error: detection.code,
    pattern: detection.pattern,
    redactedPreview: detection.redactedPreview,
    messageJa: SETUP_DEEP_LINK_MESSAGE_JA,
    nextStepJa: SETUP_DEEP_LINK_NEXTSTEP_JA,
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
