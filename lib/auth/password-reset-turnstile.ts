/**
 * Bot protection for public password-reset (POST /api/auth/forgot-password).
 *
 * Behind PASSWORD_RESET_TURNSTILE_ENABLED (default OFF). When the flag is ON
 * this guard is fail-closed: missing keys, missing token, failed siteverify,
 * helper fail-open (`not_configured`), missing/empty/wrong action, or a
 * hostname outside the allowlist → reject and never call resetPasswordForEmail.
 *
 * Caller still owns anti-enumeration: CAPTCHA errors may be shown; whether
 * the mailbox exists must not.
 */
import { createHash } from "node:crypto";
import type { TurnstileVerifyResult } from "@/lib/lp/turnstile";

export const PASSWORD_RESET_TURNSTILE_ACTION = "password_reset";
export const PASSWORD_RESET_TURNSTILE_DEFAULT_HOSTNAME = "staffpass.sealith.com";
/** Same copy for every address — never reveal whether the mailbox exists. */
export const PASSWORD_RESET_SENT_MESSAGE =
  "入力したメールアドレスが登録されている場合、パスワード再設定のメールを送りました。";

/** Separate IP brake for CAPTCHA / siteverify attempts (not the send quota). */
export const PASSWORD_RESET_CAPTCHA_IP_LIMIT = 10;
export const PASSWORD_RESET_CAPTCHA_IP_WINDOW_MS = 15 * 60_000;

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

const USED_TTL_MS = 10 * 60_000;
const USED_MAX = 10_000;
const usedTokens = new Map<string, number>();

export function passwordResetTurnstileAllowedHostnames(): string[] {
  const raw = process.env.PASSWORD_RESET_TURNSTILE_HOSTNAMES?.trim();
  if (!raw) return [PASSWORD_RESET_TURNSTILE_DEFAULT_HOSTNAME];
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : [PASSWORD_RESET_TURNSTILE_DEFAULT_HOSTNAME];
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pruneUsedTokens(now: number) {
  for (const [hash, exp] of usedTokens) {
    if (exp <= now) usedTokens.delete(hash);
  }
}

/** First successful use wins; a replay must not reach Supabase. Fail-closed if the map is full. */
export function consumePasswordResetTurnstileToken(token: string, now: number = Date.now()): boolean {
  const hash = tokenHash(token);
  pruneUsedTokens(now);
  if (usedTokens.has(hash)) return false;
  if (usedTokens.size >= USED_MAX) return false;
  usedTokens.set(hash, now + USED_TTL_MS);
  return true;
}

export function resetPasswordResetTurnstileReplayForTest() {
  usedTokens.clear();
}

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
  if (result.action !== PASSWORD_RESET_TURNSTILE_ACTION) {
    return { ok: false, error: "turnstile_failed" };
  }
  const hostname = (result.hostname || "").trim().toLowerCase();
  if (!hostname || !passwordResetTurnstileAllowedHostnames().includes(hostname)) {
    return { ok: false, error: "turnstile_failed" };
  }
  return { ok: true };
}
