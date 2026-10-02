import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  email_invalid: "メールアドレスの形式を確認してください",
  rate_limited: "しばらく待ってから再度お試しください",
  link_invalid:
    "リンクが無効か有効期限切れです。下のフォームから再設定メールを再送するか、招待者に再招待を依頼してください",
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] || ERRORS.link_invalid : null;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <h1 className="mt-5 text-2xl font-bold tracking-tight">パスワードの再設定</h1>
        {sp.sent === "1" ? (
          <p className="mt-4 text-sm muted leading-relaxed">
            登録済みのメールアドレスであれば、再設定用のリンクを送信しました。メールのリンクから新しいパスワードを設定してください。
          </p>
        ) : (
          <p className="mt-3 text-sm muted leading-relaxed">
            登録済みのメールアドレスを入力してください。再設定用のリンクをお送りします。
          </p>
        )}
        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2 text-sm text-[var(--danger)]"
          >
            {error}
          </p>
        ) : null}
        <form method="post" action="/api/auth/forgot-password" className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="muted">メール</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          <button type="submit" className="btn btn-primary w-full">
            再設定メールを送信
          </button>
        </form>
        <p className="mt-4 text-xs faint">
          <Link href="/login" className="underline">
            ログインに戻る
          </Link>
        </p>
      </div>
    </div>
  );
}
