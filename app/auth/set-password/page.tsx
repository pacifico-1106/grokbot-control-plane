import { redirect } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { getSessionContext } from "@/lib/auth/session";
import { PASSWORD_MIN_LENGTH, passwordProblemMessage } from "@/lib/auth/auth-flow";
import { isDemoMode } from "@/lib/mode";

export const dynamic = "force-dynamic";

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ flow?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const flow = sp.flow === "invite" || sp.flow === "recovery" ? sp.flow : null;
  const session = await getSessionContext();
  if (!isDemoMode() && !session.userId) {
    redirect("/login?reason=session");
  }

  const title = flow === "invite" ? "初期パスワードの設定" : "新しいパスワードの設定";

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <h1 className="mt-5 text-2xl font-bold tracking-tight">{title}</h1>
        {session.email ? (
          <p className="mt-3 text-sm muted">アカウント: {session.email}</p>
        ) : null}
        {sp.error ? (
          <p role="alert" className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2 text-sm text-[var(--danger)]">
            {passwordProblemMessage(sp.error)}
          </p>
        ) : null}
        <form method="post" action="/api/auth/set-password" className="mt-6 space-y-4">
          {flow ? <input type="hidden" name="flow" value={flow} /> : null}
          <label className="block text-sm">
            新しいパスワード（{PASSWORD_MIN_LENGTH}文字以上）
            <input
              type="password"
              name="password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete="new-password"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          <label className="block text-sm">
            新しいパスワード（確認）
            <input
              type="password"
              name="password_confirm"
              required
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete="new-password"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          <button type="submit" className="btn btn-primary w-full">
            パスワードを設定して続行
          </button>
        </form>
      </div>
    </div>
  );
}
