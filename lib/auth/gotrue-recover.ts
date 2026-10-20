/**
 * GoTrue Recover (`POST /auth/v1/recover` / resetPasswordForEmail) errors
 * that are decided before SMTP.
 *
 * Sources:
 * - https://supabase.com/docs/guides/auth/debugging/error-codes
 * - https://github.com/supabase/auth/blob/master/internal/api/recover.go
 * - https://github.com/supabase/auth/blob/master/internal/api/api.go
 *   (limitHandler + verifyCaptcha + requireEmailProvider on /recover)
 * - https://github.com/supabase/auth/blob/master/internal/api/mail.go
 *   (validateSentWithinFrequencyLimit and Email.Allow() run before send)
 *
 * 5xx, unexpected_failure, request_timeout, and unknown codes are not
 * listed: the email may already have been handed to SMTP.
 */
export const GOTRUE_RECOVER_PRE_SEND_ERROR_CODES = [
  "captcha_failed",
  "validation_failed",
  "over_email_send_rate_limit",
  "over_request_rate_limit",
  "email_provider_disabled",
  "bad_json",
  "email_address_not_authorized",
] as const;

const PRE_SEND = new Set<string>(GOTRUE_RECOVER_PRE_SEND_ERROR_CODES);

export function isGoTrueRecoverPreSendError(
  error: { code?: unknown; status?: unknown } | null | undefined
): boolean {
  const code = error?.code;
  if (typeof code !== "string" || !PRE_SEND.has(code)) return false;
  const status = error.status;
  if (typeof status === "number" && (status < 400 || status >= 500)) return false;
  return true;
}
