import Link from "next/link";
import { isDemoMode } from "@/lib/mode";

export default function SignupPage() {
  const demo = isDemoMode();

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <p className="text-xs faint">無料トライアル · 14日</p>
        <h1 className="mt-2 text-2xl font-medium tracking-tight">
          AI社員を雇い始める
        </h1>
        <p className="mt-3 text-sm muted leading-relaxed">
          {demo
            ? "デモモードです。キー未設定でもダッシュボードへ進めます。本番では Auth ユーザー＋組織＋オーナーが作成されます。"
            : "登録後はダッシュボードへ。Supabase Auth でユーザーと組織を作成し、Resend でウェルカムメールを送ります。"}
        </p>
        <form action="/api/auth/signup" method="post" className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="muted">会社名</span>
            <input
              name="orgName"
              required
              defaultValue="株式会社サンプル商事"
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          <label className="block text-sm">
            <span className="muted">メール</span>
            <input
              name="email"
              type="email"
              required
              defaultValue="owner@example.com"
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          {!demo ? (
            <label className="block text-sm">
              <span className="muted">パスワード（8文字以上）</span>
              <input
                name="password"
                type="password"
                required
                minLength={8}
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--text-faint)]"
              />
            </label>
          ) : (
            <input type="hidden" name="password" value="demo-not-used" />
          )}
          <label className="block text-sm">
            <span className="muted">導入モード</span>
            <select
              name="mode"
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              defaultValue="managed"
            >
              <option value="managed">Managed（こちらで Grok Bot を用意）</option>
              <option value="byo">BYO Grok Bot（持ち込み）</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary w-full">
            トライアルを開始してダッシュボードへ
          </button>
        </form>
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
      </div>
    </div>
  );
}
