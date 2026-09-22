/**
 * P0-A MCP Response Contract
 * Ensures MCP responses never return full secrets to agents.
 * 
 * Locked rules (2026-09-22):
 * - Employee MCP: NEVER return full secrets
 * - Admin MCP: secrets ONLY through atomic consume path (oneTimeSecret)
 * - Prefix-only display OK for ops triage
 * 
 * This module provides validation helpers and tests for enforcing the contract.
 */

import { detectSecretInPayload } from "@/lib/security/secret-detector";

export type McpResponseContractResult = {
  ok: true;
} | {
  ok: false;
  code: 'secret_in_mcp_response';
  pattern: string;
  messageJa: string;
};

const ALLOWED_SECRET_FIELDS = [
  'oneTimeSecret',
  'secretPrefix',
];

const DISALLOWED_PATTERNS = [
  /gb_emp_[a-f0-9]{16}_[a-f0-9]{32}/i,
  /gb_adm_[a-f0-9]{16}_[a-f0-9]{32}/i,
  /xox[abcprs]-[0-9A-Za-z\-]{10,}/i,
  /sk-[A-Za-z0-9]{20,}/i,
  /sk-proj-[A-Za-z0-9_\-]{20,}/i,
  /sk_(?:live|test)_[A-Za-z0-9]{24,}/i,
];

function isFullSecret(value: string): boolean {
  if (value.length < 16) return false;
  return DISALLOWED_PATTERNS.some(pattern => pattern.test(value));
}

function extractAllStrings(
  obj: unknown,
  path: string = '',
  depth: number = 0,
  maxDepth: number = 10
): Array<{ path: string; value: string }> {
  if (depth > maxDepth) return [];
  if (typeof obj === 'string') return [{ path, value: obj }];
  if (Array.isArray(obj)) {
    return obj.flatMap((item, index) =>
      extractAllStrings(item, `${path}[${index}]`, depth + 1, maxDepth)
    );
  }
  if (obj && typeof obj === 'object') {
    return Object.entries(obj).flatMap(([key, value]) =>
      extractAllStrings(value, path ? `${path}.${key}` : key, depth + 1, maxDepth)
    );
  }
  return [];
}

export function validateEmployeeMcpResponse(response: unknown): McpResponseContractResult {
  if (!response || typeof response !== 'object') return { ok: true };

  const strings = extractAllStrings(response);

  for (const { path, value } of strings) {
    if (ALLOWED_SECRET_FIELDS.some(field => path.endsWith(field))) continue;

    if (path.endsWith('secretPrefix') && value.length <= 14) continue;

    if (isFullSecret(value)) {
      return {
        ok: false,
        code: 'secret_in_mcp_response',
        pattern: path,
        messageJa: `Employee MCP レスポンスに完全なシークレットが含まれています（${path}）。社員証 MCP は秘密情報を返しません。`,
      };
    }
  }

  return { ok: true };
}

export function validateAdminMcpResponse(
  response: unknown,
  options?: { allowOneTimeSecret?: boolean }
): McpResponseContractResult {
  if (!response || typeof response !== 'object') return { ok: true };

  const strings = extractAllStrings(response);

  for (const { path, value } of strings) {
    if (path.endsWith('secretPrefix') && value.length <= 14) continue;

    if (options?.allowOneTimeSecret && path.endsWith('oneTimeSecret')) continue;

    if (isFullSecret(value)) {
      return {
        ok: false,
        code: 'secret_in_mcp_response',
        pattern: path,
        messageJa: `Admin MCP レスポンスに不正なシークレットが含まれています（${path}）。oneTimeSecret 以外のフルシークレットは禁止です。`,
      };
    }
  }

  return { ok: true };
}

export function sanitizeSecretForDisplay(secret: string, maxPrefixLength: number = 14): string {
  if (secret.length <= maxPrefixLength) return secret;
  return secret.slice(0, maxPrefixLength) + '***';
}

export function isSecretPrefix(value: string): boolean {
  if (value.length > 14) return false;
  return value.startsWith('gb_emp_') || value.startsWith('gb_adm_') || value.startsWith('xoxb-');
}

export function assertNoFullSecretInEmployeeMcp(response: unknown): void {
  const result = validateEmployeeMcpResponse(response);
  if (!result.ok) {
    throw new Error(`MCP Response Contract Violation: ${result.messageJa}`);
  }
}

export function assertNoUnauthorizedSecretInAdminMcp(
  response: unknown,
  options?: { allowOneTimeSecret?: boolean }
): void {
  const result = validateAdminMcpResponse(response, options);
  if (!result.ok) {
    throw new Error(`MCP Response Contract Violation: ${result.messageJa}`);
  }
}

export const MCP_RESPONSE_CONTRACT_RULES = {
  employeeMcp: {
    rule: 'Employee MCP は完全なシークレットを返しません',
    allowed: ['secretPrefix (14文字以下のプレフィックス)'],
    forbidden: ['gb_emp_*, gb_adm_*, xox*, sk-*, トークン全文'],
  },
  adminMcp: {
    rule: 'Admin MCP は oneTimeSecret パス経由でのみ秘密を返します',
    allowed: ['oneTimeSecret (アトミック消費)', 'secretPrefix (プレフィックスのみ)'],
    forbidden: ['その他フィールドのフルシークレット'],
  },
  chatSurfaces: {
    rule: 'チャット (Slack/LINE) には秘密情報を含めません',
    allowed: ['セットアップリンク', '承認カード', 'nextStepJa'],
    forbidden: ['パスワード', 'リフレッシュトークン', 'API キー', '社員証/管理証シークレット'],
  },
};
