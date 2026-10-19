/**
 * User-facing copy for Staffpass dashboard sign-in failures.
 * Never echo raw JSON, HTTP status text, or internal error codes in the UI.
 * Do not distinguish "unknown email" vs "wrong password".
 */

export type LoginErrorCode =
  | "login_failed"
  | "credentials_required"
  | "rate_limited"
  | "login_unavailable"
  | "session_expired"
  | "session"
  | "turnstile_required"
  | "turnstile_failed";

export const LOGIN_FAILED_MESSAGE = "メールアドレスまたはパスワードが違います";
export const CREDENTIALS_REQUIRED_MESSAGE = "メールとパスワードを入力してください";
export const RATE_LIMITED_MESSAGE = "しばらく待ってから再度お試しください";
export const LOGIN_UNAVAILABLE_MESSAGE =
  "現在ログインできません。時間をおいてお試しください。";
export const SESSION_REQUIRED_MESSAGE =
  "ログインが必要です。再度サインインしてください。";
export const TURNSTILE_REQUIRED_MESSAGE =
  "ロボットでないことの確認を完了してください";
export const TURNSTILE_FAILED_MESSAGE =
  "確認に失敗しました。ページを再読み込みしてもう一度お試しください。";

export function loginErrorMessage(
  code?: string | null,
  status?: number
): string {
  if (status === 429 || code === "rate_limited") return RATE_LIMITED_MESSAGE;
  if (status === 503 || code === "login_unavailable") return LOGIN_UNAVAILABLE_MESSAGE;
  if (code === "credentials_required") return CREDENTIALS_REQUIRED_MESSAGE;
  if (code === "turnstile_required") return TURNSTILE_REQUIRED_MESSAGE;
  if (code === "turnstile_failed") return TURNSTILE_FAILED_MESSAGE;
  if (code === "session_expired" || code === "session") {
    return SESSION_REQUIRED_MESSAGE;
  }
  return LOGIN_FAILED_MESSAGE;
}

export function isSessionNotice(reason?: string | null): boolean {
  return reason === "session" || reason === "expired" || reason === "session_expired";
}

/** Query used when a native form POST must bounce back to /login instead of JSON. */
export function loginFailureSearchParams(input: {
  code: LoginErrorCode;
  email?: string;
  next?: string;
}): string {
  const params = new URLSearchParams();
  params.set("error", input.code);
  const email = (input.email || "").trim();
  if (email.includes("@")) params.set("email", email);
  const next = input.next || "";
  if (next && next !== "/app") params.set("next", next);
  return params.toString();
}
