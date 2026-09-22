/**
 * P0-A Secret-in-chat detector
 * Detects and rejects/redacts secrets in gateway invoke and approval request bodies.
 * Fail-closed: secrets never pass through to chat surfaces.
 * 
 * Locked rules (2026-09-22):
 * - Chat OK: short-lived setup links, approval cards, status/nextStepJa
 * - Chat NEVER: passwords, refresh tokens, API keys, full employee/admin badge secrets
 * - Prefix-only OK for ops triage
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
