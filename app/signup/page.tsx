import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { isDemoMode } from "@/lib/mode";
import { LegalLinks } from "@/components/LegalLinks";

export default function SignupPage() {
  const demo = isDemoMode();

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <p className="mt-5 text-xs faint">無料トライアル · 14日</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          AI社員を雇い始める
        </h1>
        <p className="mt-3 text-sm muted leading-relaxed">
          {demo
            ? "デモモードです。設定がなくてもダッシュボードへ進めます。本番では会社アカウントと管理者を作成します。"
            : "登録後はダッシュボードへ。会社アカウントを作成し、ウェルカムメールをお送りします。"}
        </p>
        <form action="/api/auth/signup" method="post" className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="muted">会社名</span>
            <input
              name="orgName"
              required
              defaultValue="株式会社サンプル商事"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          <label className="block text-sm">
            <span className="muted">メール</span>
            <input
              name="email"
              type="email"
              required
              defaultValue={demo ? "owner@example.com" : ""}
              placeholder={demo ? undefined : "you@company.com"}
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
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
                className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
              />
            </label>
          ) : (
            <input type="hidden" name="password" value="demo-not-used" />
          )}
          <label className="block text-sm">
            <span className="muted">導入モード</span>
            <select
              name="mode"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm"
              defaultValue="managed"
            >
              <option value="managed">おまかせ導入（こちらで Grok Bot を用意）</option>
              <option value="byo">今の Grok Bot に載せる（持ち込み）</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="muted">紹介コード（任意）</span>
            <input
              name="referral_code"
              type="text"
              placeholder="AIC-XXXX"
              autoComplete="off"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          <label className="flex items-start gap-3 rounded-xl border border-[var(--border-soft)] bg-[var(--bg-soft)] p-3 text-xs leading-relaxed muted">
            <input name="legal_agreement" type="checkbox" value="accepted" required className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-strong)]" />
            <span>
              <Link href="/legal/terms" target="_blank" className="underline">利用規約</Link>および
              <Link href="/legal/privacy" target="_blank" className="underline">プライバシーポリシー</Link>に同意し、
              <Link href="/legal/commercial-transactions" target="_blank" className="underline">特定商取引法に基づく表記</Link>を確認しました。
            </span>
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
        <LegalLinks className="mt-5 border-t border-[var(--border-soft)] pt-4 text-[11px] faint" />
      </div>
    </div>
  );
}
