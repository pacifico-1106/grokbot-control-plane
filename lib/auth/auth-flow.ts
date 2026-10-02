/**
 * Pure helpers for the Supabase email-link flows (invite / recovery / magic link):
 * /auth/confirm → verifyOtp(token_hash) → /auth/set-password → /app.
 *
 * Kept framework-free so they are unit-testable without Next/Supabase.
 */
import { createHash } from "node:crypto";
import { resolveAppOrigin } from "../app-url";

/** Email link types this app accepts. Signup confirmation / email_change are not used. */
export const EMAIL_LINK_TYPES = ["invite", "recovery", "magiclink"] as const;
export type EmailLinkType = (typeof EMAIL_LINK_TYPES)[number];

export function parseEmailLinkType(raw: unknown): EmailLinkType | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (EMAIL_LINK_TYPES as readonly string[]).includes(v) ? (v as EmailLinkType) : null;
}

/**
 * Supabase token_hash is a hex digest (optionally `pkce_`-prefixed); PKCE auth
 * code is a UUID. Accept only a conservative charset so the value is safe to
 * echo into the interstitial HTML and cannot smuggle anything else.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function parseTokenHash(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  return TOKEN_RE.test(v) ? v : null;
}

export function parseAuthCode(raw: unknown): string | null {
  return parseTokenHash(raw);
}

/** Where to land after a successful verify. Invite/recovery must set a password first. */
export function destinationAfterVerify(type: EmailLinkType): string {
  return type === "magiclink" ? "/app" : `/auth/set-password?flow=${type}`;
}

export const PASSWORD_MIN_LENGTH = 10;
/** bcrypt (GoTrue) truncates at 72 bytes. */
export const PASSWORD_MAX_BYTES = 72;

export type PasswordProblem =
  | "password_required"
  | "password_too_short"
  | "password_too_long"
  | "password_mismatch"
  | "password_weak";

export function validateNewPassword(
  password: string,
  confirm: string,
  email?: string | null
): PasswordProblem | null {
  if (!password) return "password_required";
  if ([...password].length < PASSWORD_MIN_LENGTH) return "password_too_short";
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) return "password_too_long";
  if (password !== confirm) return "password_mismatch";
  const lower = password.toLowerCase();
  const local = (email || "").split("@")[0]?.toLowerCase() || "";
  if (/^(.)\1+$/.test(password) || (local.length >= 4 && lower.includes(local))) {
    return "password_weak";
  }
  return null;
}

export function passwordProblemMessage(code: string | null | undefined): string {
  switch (code) {
    case "password_required":
      return "パスワードを入力してください";
    case "password_too_short":
      return `パスワードは${PASSWORD_MIN_LENGTH}文字以上にしてください`;
    case "password_too_long":
      return "パスワードが長すぎます（72バイト以内）";
    case "password_mismatch":
      return "確認用パスワードが一致しません";
    case "password_weak":
      return "推測されやすいパスワードです（メールアドレスや同じ文字の繰り返しは使えません）";
    case "rate_limited":
      return "しばらく待ってから再度お試しください";
    case "forbidden":
      return "不正なリクエストです。ページを再読み込みしてやり直してください";
    default:
      return "パスワードを設定できませんでした。リンクの有効期限が切れている場合は再発行してください";
  }
}

/**
 * CSRF guard for state-changing auth POSTs (cookie-bound session).
 * Requires a same-origin Origin header (or, if a browser omits Origin,
 * Sec-Fetch-Site: same-origin). Cross-site form posts are rejected — this
 * also blocks login-CSRF via a forged /auth/confirm POST.
 */
export function isSameOriginRequest(
  headers: Pick<Headers, "get">,
  requestUrl: string,
  appOrigin: string = resolveAppOrigin()
): boolean {
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(requestUrl).origin);
  } catch {
    /* ignore */
  }
  allowed.add(appOrigin);

  const origin = headers.get("origin");
  if (origin && origin !== "null") return allowed.has(origin);
  if (origin === "null") return false;
  return headers.get("sec-fetch-site") === "same-origin";
}

export function clientIp(headers: Pick<Headers, "get">): string {
  return (
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function rateKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

/**
 * Cheap per-instance fixed-window limiter (best effort on serverless; Supabase
 * Auth also enforces its own email + verify rate limits server-side).
 */
export function takeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): boolean {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      if (buckets.size >= MAX_BUCKETS) buckets.clear();
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

export function resetRateLimitsForTest(): void {
  buckets.clear();
}

export function isPlausibleEmail(raw: string): boolean {
  return raw.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}

/**
 * Interstitial for GET /auth/confirm. One-time tokens are only consumed on an
 * explicit same-origin POST, so mail scanners / link previews that prefetch
 * the GET cannot burn the invite.
 */
export function renderConfirmInterstitial(input: {
  type: EmailLinkType;
  tokenHash?: string | null;
  code?: string | null;
}): string {
  const title =
    input.type === "invite"
      ? "Staffpass への招待"
      : input.type === "recovery"
        ? "パスワードの再設定"
        : "Staffpass にログイン";
  const lead =
    input.type === "magiclink"
      ? "下のボタンを押すとログインします。"
      : "下のボタンを押して続行し、次の画面でパスワードを設定してください。";
  const hidden = [
    `<input type="hidden" name="type" value="${escapeHtml(input.type)}">`,
    input.tokenHash
      ? `<input type="hidden" name="token_hash" value="${escapeHtml(input.tokenHash)}">`
      : "",
    input.code ? `<input type="hidden" name="code" value="${escapeHtml(input.code)}">` : "",
  ].join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#f7f7f8;color:#111;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<main style="background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:32px;max-width:420px;width:100%">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
<p style="font-size:14px;color:#555;line-height:1.6">${escapeHtml(lead)}</p>
<form method="post" action="/auth/confirm">${hidden}
<button type="submit" style="margin-top:16px;width:100%;padding:12px;border:0;border-radius:8px;background:#111;color:#fff;font-size:15px;cursor:pointer">続行する</button>
</form>
<p style="font-size:12px;color:#888;margin-top:16px">心当たりがない場合はこのページを閉じてください。</p>
</main></body></html>`;
}

export const AUTH_PAGE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
};
