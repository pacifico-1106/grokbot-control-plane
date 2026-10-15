/** Display-only email mask. Never emit the original local-part beyond the first char. */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const POLL_PATH_RE = /\/api\/approvals\/status\?[^\s"'<>]*/gi;
const TOKENISH_RE = /\b(?:statusToken|pollPath|pollUrl|poll_path|status_token)[=:]\s*[^\s"'<>]+/gi;

export function isEmailLike(value: string): boolean {
  const t = value.trim();
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(t);
}

/**
 * a***@example.com — 1-char local → *@domain.
 * Non-email actor keys (slack:U…) return null so they are not shown as mail.
 */
export function maskEmail(raw: string | null | undefined): string | null {
  const email = extractEmail(raw);
  if (!email) return null;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || !domain) return null;
  if (local.length === 1) return `*@${domain}`;
  return `${local[0]}***@${domain}`;
}

export function extractEmail(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const stripped = text.replace(/^(web|email):/i, "");
  const match = stripped.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return match ? match[0].toLowerCase() : null;
}

export function maskEmailsInText(text: string): string {
  return String(text ?? "").replace(EMAIL_RE, (m) => maskEmail(m) ?? "[redacted]");
}

/** Strip tokens / poll URLs that must never reach /app/audit HTML. */
export function sanitizeAuditDisplayText(text: string): string {
  return maskEmailsInText(String(text ?? ""))
    .replace(POLL_PATH_RE, "[redacted]")
    .replace(TOKENISH_RE, "[redacted]");
}

export function clipAuditText(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  if (max <= 1) return "…";
  return `${t.slice(0, max - 1)}…`;
}
