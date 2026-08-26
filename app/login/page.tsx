import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { isDemoMode } from "@/lib/mode";
import { LegalLinks } from "@/components/LegalLinks";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = sp.next || "/app";
  const demo = isDemoMode();

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <p className="mt-5 text-xs faint">ログイン</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          管理画面
        </h1>
        {demo ? (
          <p className="mt-3 text-sm muted leading-relaxed">
            デモモード（Supabase キー未設定）。そのままダッシュボードを開けます。キーを入れた後は本番ログインが有効になります。
          </p>
        ) : (
          <p className="mt-3 text-sm muted leading-relaxed">
            登録済みのメールとパスワードでサインインしてください。
          </p>
        )}
        <form action="/api/auth/login" method="post" className="mt-6 space-y-4">
          <input type="hidden" name="next" value={next} />
          <label className="block text-sm">
            <span className="muted">メール</span>
            <input
              name="email"
              type="email"
              required={!demo}
              defaultValue={demo ? "owner@example.com" : ""}
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          <label className="block text-sm">
            <span className="muted">パスワード</span>
            <input
              name="password"
              type="password"
              required={!demo}
              minLength={demo ? undefined : 8}
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          <button type="submit" className="btn btn-primary w-full">
            {demo ? "デモでダッシュボードへ" : "ログイン"}
          </button>
        </form>
        <p className="mt-4 text-xs faint">
          アカウント未作成の方は{" "}
          <Link href="/signup" className="underline">
            トライアル登録
          </Link>
        </p>
        <LegalLinks className="mt-5 border-t border-[var(--border-soft)] pt-4 text-[11px] faint" />
      </div>
    </div>
  );
}
