/**
 * Bot protection for public password-reset (POST /api/auth/forgot-password).
 *
 * Behind PASSWORD_RESET_TURNSTILE_ENABLED (default OFF). When the flag is ON
 * this guard is fail-closed: missing keys, missing token, failed siteverify,
 * helper fail-open (`not_configured`), or a token minted for another widget
 * action → reject and never call resetPasswordForEmail.
 *
 * Caller still owns anti-enumeration: CAPTCHA errors may be shown; whether
 * the mailbox exists must not.
 */
import type { TurnstileVerifyResult } from "@/lib/lp/turnstile";

export const PASSWORD_RESET_TURNSTILE_ACTION = "password_reset";

export type PasswordResetTurnstileInput = {
  turnstileToken: string;
  clientIp?: string;
};

export type PasswordResetTurnstileDeps = {
  turnstileConfigured: () => boolean;
  verifyTurnstile: (token: string, remoteIp?: string) => Promise<TurnstileVerifyResult>;
};

export type PasswordResetTurnstileResult =
  | { ok: true }
  | { ok: false; error: "turnstile_required" | "turnstile_failed" };

export async function evaluatePasswordResetTurnstile(
  input: PasswordResetTurnstileInput,
  deps: PasswordResetTurnstileDeps
): Promise<PasswordResetTurnstileResult> {
  if (!deps.turnstileConfigured()) {
    return { ok: false, error: "turnstile_failed" };
  }
  const token = (input.turnstileToken || "").trim();
  if (!token) return { ok: false, error: "turnstile_required" };
  const result = await deps.verifyTurnstile(token, input.clientIp);
  const notConfigured = result.errorCodes?.includes("not_configured");
  if (!result.success || notConfigured) {
    return { ok: false, error: "turnstile_failed" };
  }
  if (result.action !== undefined && result.action !== PASSWORD_RESET_TURNSTILE_ACTION) {
    return { ok: false, error: "turnstile_failed" };
  }
  return { ok: true };
}
