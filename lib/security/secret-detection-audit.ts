/**
 * Audit rows for the secret detector (2026-10-05).
 *
 * - secret_detection.blocked: written on EVERY path that rejects a payload.
 * - secret_detection.suspected: a 40-char key-like string without AWS context
 *   (not blocked), so false-negative risk stays observable.
 *
 * Metadata: surface, tool, jobId, pattern, fieldPath, matchLength. NEVER the
 * body, the matched value, a prefix of it, or any hash of it. tool / jobId
 * are echoed only when they are themselves clean (see safeEcho).
 *
 * Org scoping: callers pass the org of the authenticated credential /
 * employee, never a client-supplied org. With no org the row is skipped
 * (the request is still rejected).
 *
 * Fail-closed: a write failure never turns a rejection into a pass; this
 * module never throws.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import {
  SECRET_REDACTED_PREVIEW,
  detectSecretInString,
  type SecretDetectionResult,
  type SecretFinding,
} from "@/lib/security/secret-detector";

export const SECRET_DETECTION_BLOCKED = "secret_detection.blocked" as const;
export const SECRET_DETECTION_SUSPECTED = "secret_detection.suspected" as const;

export type SecretDetectionSurface = "gateway_invoke" | "admin_queue" | "config_change_request";

type AuditWriter = typeof appendAuditEvent;
let writer: AuditWriter = appendAuditEvent;

/** Tests only: replace the audit writer (null restores the real one). */
export function __setSecretDetectionAuditWriterForTests(next: AuditWriter | null): void {
  writer = next ?? appendAuditEvent;
}

/**
 * Echo a request field (tool / jobId / purpose) only if it carries no
 * secret-like content itself; otherwise a constant. Keeps the key for compatibility.
 */
export function safeEcho(value: string | null | undefined, max = 200): string | null {
  if (value == null) return null;
  const v = String(value);
  if (v.length > max) return SECRET_REDACTED_PREVIEW;
  const r = detectSecretInString(v);
  if (!r.ok || r.suspected) return SECRET_REDACTED_PREVIEW;
  return v;
}

type Scope = {
  orgId: string | null;
  employeeId: string | null;
  credentialId: string | null;
  surface: SecretDetectionSurface;
  tool: string | null;
  jobId: string | null;
};

async function write(
  action: typeof SECRET_DETECTION_BLOCKED | typeof SECRET_DETECTION_SUSPECTED,
  scope: Scope,
  summary: string,
  metadata: Record<string, unknown>
): Promise<boolean> {
  if (!scope.orgId) return false;
  try {
    await writer({
      orgId: scope.orgId,
      employeeId: scope.employeeId,
      credentialId: scope.credentialId,
      action,
      purpose: null,
      summary,
      metadata: {
        surface: scope.surface,
        tool: safeEcho(scope.tool),
        jobId: safeEcho(scope.jobId),
        ...metadata,
      },
    });
    return true;
  } catch (err) {
    // Fixed text only: no payload, no value, no driver error text.
    console.warn(`[secret-detection] audit write failed (${action}, ${scope.surface})`, err instanceof Error ? err.name : "error");
    return false;
  }
}

/** One row per rejection. Returns false if not written (rejection stands either way). */
export function auditSecretDetectionBlocked(
  scope: Scope,
  detection: SecretDetectionResult & { ok: false }
): Promise<boolean> {
  return write(
    SECRET_DETECTION_BLOCKED,
    scope,
    `秘密情報の可能性がある値を検出して拒否（${detection.pattern}）`,
    { code: detection.code, pattern: detection.pattern, fieldPath: detection.fieldPath, matchLength: detection.matchLength }
  );
}

/** One row per request with suspected hits (first hit + count). Best-effort. */
export function auditSecretDetectionSuspected(scope: Scope, suspected: SecretFinding[]): Promise<boolean> {
  const first = suspected[0];
  if (!first) return Promise.resolve(false);
  return write(
    SECRET_DETECTION_SUSPECTED,
    scope,
    `鍵に似た文字列（${first.pattern}）を検出（文脈なしのため送信は許可）`,
    { pattern: first.pattern, fieldPath: first.fieldPath, matchLength: first.length, count: suspected.length }
  );
}
