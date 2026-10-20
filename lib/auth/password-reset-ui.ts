/**
 * Client-safe password-reset copy and widget action.
 * Keep node:crypto (replay hash) out of the browser bundle.
 */
export const PASSWORD_RESET_TURNSTILE_ACTION = "password_reset";

/** Same copy for every address — never reveal whether the mailbox exists. */
export const PASSWORD_RESET_SENT_MESSAGE =
  "入力したメールアドレスが登録されている場合、パスワード再設定のメールを送りました。";
