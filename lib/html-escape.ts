/**
 * Escaping helpers for outbound email (and any HTML string templates).
 * Every user-controlled value interpolated into email HTML must pass through
 * escapeHtml; every subject passes through sanitizeEmailSubject.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

const SUBJECT_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
export const EMAIL_SUBJECT_MAX = 200;

/** Single line, no control characters (header-injection safe), bounded length. */
export function sanitizeEmailSubject(value: unknown): string {
  const s = String(value ?? "").replace(SUBJECT_CONTROL, " ").replace(/\s{2,}/g, " ").trim();
  return s.length > EMAIL_SUBJECT_MAX ? `${s.slice(0, EMAIL_SUBJECT_MAX - 1)}…` : s;
}
