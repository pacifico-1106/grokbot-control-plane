import Link from "next/link";

export default function SignupPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <p className="text-xs faint">無料トライアル · 14日</p>
        <h1 className="mt-2 text-2xl font-medium tracking-tight">
          AI社員を雇い始める
        </h1>
        <p className="mt-3 text-sm muted leading-relaxed">
          登録後はダッシュボードへ。Resend でウェルカム / トライアル開始メールを送ります（キー未設定時はスタブ）。
        </p>
        <form action="/api/trial" method="post" className="mt-6 space-y-4">
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
          すでに開始済みの方は{" "}
          <Link href="/app" className="underline">
            ダッシュボード
          </Link>
        </p>
      </div>
    </div>
  );
}
