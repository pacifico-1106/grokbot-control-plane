/**
 * Bot protection for public self-serve signup (POST /api/auth/signup).
 *
 * P0 hotfix 2026-10-03 (spam-sample-20261003): a form bot submitted /signup
 * with the prefilled company name and random uppercase referral codes, creating
 * one org + Auth user per hit and triggering welcome mail to third parties.
 *
 * This guard is intentionally NOT behind a feature flag:
 * - Turnstile is fail-closed outside DEMO mode: missing keys, missing token,
 *   failed siteverify, or a token minted for another widget action → reject.
 * - Honeypot field must be empty.
 * - Referral code, when present, must look like AIC-XXXX.
 * - Org name must be real text (not the demo placeholder), ≤ 100 chars, no
 *   control characters.
 *
 * Runs BEFORE any Auth user / org is created and before any email is sent.
 */
import { DEMO_ORG } from "@/lib/demo-data";
import type { TurnstileVerifyResult } from "@/lib/lp/turnstile";

export const SIGNUP_TURNSTILE_ACTION = "signup";
export const SIGNUP_HONEYPOT_FIELD = "company_website";
export const SIGNUP_ORG_NAME_MAX = 100;
export const REFERRAL_CODE_PATTERN = /^AIC-[A-Z0-9]{4,16}$/;

export type SignupGuardInput = {
  orgName: string;
  referralCode: string;
  honeypot: string;
  turnstileToken: string;
  clientIp?: string;
  demo: boolean;
};

export type SignupGuardDeps = {
  turnstileConfigured: () => boolean;
  verifyTurnstile: (token: string, remoteIp?: string) => Promise<TurnstileVerifyResult>;
};

export type SignupGuardResult =
  | { ok: true; orgName: string; referralCode: string | null }
  | { ok: false; status: number; error: string; message: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Upper-cased AIC- code, null when empty, or "invalid". */
export function parseReferralCode(raw: string): string | null | "invalid" {
  const v = (raw || "").trim().toUpperCase();
  if (!v) return null;
  return REFERRAL_CODE_PATTERN.test(v) ? v : "invalid";
}

export function validateSignupOrgName(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const v = (raw || "").normalize("NFKC").trim();
  if (!v) return { ok: false, message: "会社名を入力してください" };
  if (v === DEMO_ORG.name) return { ok: false, message: "会社名を入力してください（サンプルの会社名は使えません）" };
  if (v.length > SIGNUP_ORG_NAME_MAX) return { ok: false, message: `会社名は${SIGNUP_ORG_NAME_MAX}文字以内で入力してください` };
  if (CONTROL_CHARS.test(v)) return { ok: false, message: "会社名に使用できない文字が含まれています" };
  return { ok: true, value: v };
}

function reject(status: number, error: string, message: string): SignupGuardResult {
  return { ok: false, status, error, message };
}

export async function evaluateSignupGuard(
  input: SignupGuardInput,
  deps: SignupGuardDeps
): Promise<SignupGuardResult> {
  if ((input.honeypot || "").trim() !== "") {
    // Generic message: do not tell bots which check fired.
    return reject(400, "signup_rejected", "登録を受け付けられませんでした。時間をおいて再度お試しください。");
  }

  const org = validateSignupOrgName(input.orgName);
  if (!org.ok) return reject(400, "invalid_org_name", org.message);

  const referral = parseReferralCode(input.referralCode);
  if (referral === "invalid") {
    return reject(400, "invalid_referral_code", "紹介コードは AIC-XXXX の形式で入力してください（不明な場合は空欄）");
  }

  if (!input.demo) {
    if (!deps.turnstileConfigured()) {
      // Fail closed: never create accounts without bot verification in production.
      return reject(503, "bot_protection_unavailable", "現在、新規登録を一時停止しています。お問い合わせフォームからご連絡ください。");
    }
    const token = (input.turnstileToken || "").trim();
    if (!token) return reject(400, "turnstile_required", "ロボットでないことの確認を完了してください");
    const result = await deps.verifyTurnstile(token, input.clientIp);
    const notConfigured = result.errorCodes?.includes("not_configured");
    if (!result.success || notConfigured) {
      return reject(403, "turnstile_failed", "確認に失敗しました。ページを再読み込みしてもう一度お試しください。");
    }
    if (result.action !== undefined && result.action !== SIGNUP_TURNSTILE_ACTION) {
      return reject(403, "turnstile_failed", "確認に失敗しました。ページを再読み込みしてもう一度お試しください。");
    }
  }

  return { ok: true, orgName: org.value, referralCode: referral };
}
