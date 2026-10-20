import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { ForgotPasswordForm } from "@/components/ForgotPasswordForm";
import { isPasswordResetTurnstileEnabled, isSupabaseAuthCaptchaEnabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  email_invalid: "メールアドレスの形式を確認してください",
  rate_limited: "しばらく待ってから再度お試しください",
  link_invalid:
    "リンクが無効か有効期限切れです。下のフォームから再設定メールを再送するか、招待者に再招待を依頼してください",
  turnstile_required: "ロボットでないことの確認を完了してください",
  turnstile_failed: "確認に失敗しました。ページを再読み込みしてもう一度お試しください。",
};

function passwordResetTurnstileSiteKey(): string | null {
  if (!isPasswordResetTurnstileEnabled() && !isSupabaseAuthCaptchaEnabled()) return null;
  const key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  if (!key || key.startsWith("replace_me")) return null;
  return key;
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] || ERRORS.link_invalid : null;
  const siteKey = passwordResetTurnstileSiteKey();
  const localTurnstile = Boolean(siteKey && isPasswordResetTurnstileEnabled());
  const supabaseCaptcha = Boolean(siteKey && isSupabaseAuthCaptchaEnabled());

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <h1 className="mt-5 text-2xl font-bold tracking-tight">パスワードの再設定</h1>
        <ForgotPasswordForm
          siteKey={siteKey}
          localTurnstile={localTurnstile}
          supabaseCaptcha={supabaseCaptcha}
          initialSent={sp.sent === "1"}
          initialError={error}
        />
        <p className="mt-4 text-xs faint">
          <Link href="/login" className="underline">
            ログインに戻る
          </Link>
        </p>
      </div>
    </div>
  );
}
