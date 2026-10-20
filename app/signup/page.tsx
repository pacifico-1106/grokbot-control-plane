import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { SignupForm } from "@/components/SignupForm";
import { isDemoMode } from "@/lib/mode";
import { LegalLinks } from "@/components/LegalLinks";
import { isSupabaseAuthCaptchaEnabled } from "@/lib/feature-flags";

/** Fixed messages keyed by error code — never echo request input back into the page. */
const SIGNUP_ERROR_MESSAGES: Record<string, string> = {
  signup_rejected: "登録を受け付けられませんでした。時間をおいて再度お試しください。",
  invalid_org_name: "会社名を正しく入力してください（サンプルの会社名は使えません・100文字以内）。",
  invalid_referral_code: "紹介コードは AIC-XXXX の形式で入力してください（不明な場合は空欄）。",
  bot_protection_unavailable: "現在、新規登録を一時停止しています。お問い合わせフォームからご連絡ください。",
  signup_unavailable: "現在、新規登録を一時停止しています。時間をおいてお試しください。",
  turnstile_required: "ロボットでないことの確認を完了してください。",
  turnstile_failed: "確認に失敗しました。ページを再読み込みしてもう一度お試しください。",
  rate_limited: "短時間に多くの登録がありました。時間をおいて再度お試しください。",
  disposable_domain: "このメールアドレスのドメインはご利用いただけません。会社のメールアドレスをお使いください。",
  invalid_dots: "メールアドレスの形式が正しくありません。",
  duplicate_normalized: "このメールアドレスは既に登録されています。ログインしてください。",
};

function turnstileSiteKey(): string | null {
  const key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  if (!key || key.startsWith("replace_me")) return null;
  return key;
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const demo = isDemoMode();
  const sp = (await searchParams) ?? {};
  const errorMessage = sp.error ? SIGNUP_ERROR_MESSAGES[sp.error] ?? null : null;
  const siteKey = demo ? null : turnstileSiteKey();
  const signupClosed = !demo && !siteKey;
  const supabaseCaptcha = Boolean(siteKey && isSupabaseAuthCaptchaEnabled());

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <p className="mt-5 text-xs faint">無料トライアル · 14日</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">AI社員を雇い始める</h1>
        <p className="mt-3 text-sm muted leading-relaxed">
          {demo
            ? "デモモードです。設定がなくてもダッシュボードへ進めます。本番では会社アカウントと管理者を作成します。"
            : "登録後はダッシュボードへ。会社アカウントを作成し、ウェルカムメールをお送りします。"}
        </p>
        {errorMessage ? (
          <p role="alert" className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] p-3 text-sm">
            {errorMessage}
          </p>
        ) : null}
        <SignupForm
          demo={demo}
          siteKey={siteKey}
          signupClosed={signupClosed}
          supabaseCaptcha={supabaseCaptcha}
          closedMessage={SIGNUP_ERROR_MESSAGES.bot_protection_unavailable}
        />
        <ol className="mt-5 space-y-1 text-xs faint list-decimal list-inside">
          <li>ダッシュボードを開く</li>
          <li>はじめに のチェックリスト</li>
          <li>AI社員を雇う</li>
        </ol>
        <p className="mt-4 text-xs faint">
          すでにアカウントがある方は{" "}
          <Link href="/login" className="underline">
            ログイン
          </Link>
          {" · "}
          <Link href="/app" className="underline">
            ダッシュボード
          </Link>
        </p>
        <LegalLinks className="mt-5 border-t border-[var(--border-soft)] pt-4 text-[11px] faint" />
      </div>
    </div>
  );
}
