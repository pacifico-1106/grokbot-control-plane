import Link from "next/link";

const FEATURES = [
  {
    title: "社員証",
    body: "職務・目的・スコープ・期限。失効できる権限の束を、AI社員ごとに発行します。",
  },
  {
    title: "承認ゲート",
    body: "危険操作は人間が「要対応」で許可してから実行。fail-closed が既定です。",
  },
  {
    title: "監査タイムライン",
    body: "誰が・何目的で・何をしたかを構造化証跡で残し、情シスがその場で説明できます。",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="mx-auto max-w-5xl px-6 py-5 flex items-center justify-between">
        <div>
          <div className="text-xs faint">Grok Bot × 制御面</div>
          <div className="text-sm font-medium">AI社員 for Grok Bot</div>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/app" className="btn btn-ghost text-sm">
            ダッシュボード
          </Link>
          <Link href="/signup" className="btn btn-primary text-sm">
            無料トライアル
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-24">
        <section className="pt-16 md:pt-24 max-w-3xl">
          <p className="chip mb-6">中小企業の経営者・情シス向け</p>
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.15]">
            AIを入れるな。
            <br />
            AI社員を雇え。
          </h1>
          <p className="mt-6 text-lg muted leading-relaxed">
            動くだけのボットではなく、職務分掌・承認・監査がついた
            <span className="text-[var(--text)]">「説明できる AI 社員」</span>
            を Grok Bot の上に載せます。手足の環境は共有でも、できることと残るログは分けられます。
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className="btn btn-primary">
              14日間トライアルを始める
            </Link>
            <Link href="/app/approvals" className="btn btn-ghost">
              承認キューを見る
            </Link>
          </div>
          <p className="mt-4 text-xs faint">
            カード / 銀行振込（customer_balance）対応予定 · Resend で通知
          </p>
        </section>

        <section className="mt-20 grid md:grid-cols-3 gap-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="surface p-5">
              <h2 className="text-sm font-medium">{f.title}</h2>
              <p className="mt-3 text-sm muted leading-relaxed">{f.body}</p>
            </div>
          ))}
        </section>

        <section className="mt-16 surface p-6 md:p-8">
          <h2 className="text-xl font-medium tracking-tight">
            入れ方はふたつ。Managed か、BYO Grok Bot か。
          </h2>
          <div className="mt-6 grid md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-5">
              <div className="text-sm font-medium">Managed</div>
              <p className="mt-2 text-sm muted leading-relaxed">
                こちらで Grok Bot 環境を用意。制御面に最初から接続された状態でお渡しします。
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-5">
              <div className="text-sm font-medium">BYO Grok Bot</div>
              <p className="mt-2 text-sm muted leading-relaxed">
                既存の Grok Bot を持ち込み。社員証ゲートと監査だけを制御面に接続します。
              </p>
            </div>
          </div>
        </section>

        <section className="mt-16 max-w-2xl">
          <h2 className="text-xl font-medium">キャッチコピー</h2>
          <ul className="mt-4 space-y-3 text-sm muted">
            <li>「禁止するな。説明できるレールを敷け。」</li>
            <li>「同じ箱でも、営業Botと経理Botで権限もログも違う。」</li>
            <li>「決済レールは借りる。説明責任の台帳は自前。」</li>
          </ul>
        </section>
      </main>

      <footer className="border-t border-[var(--border)] py-8 text-center text-xs faint">
        AI社員 for Grok Bot · Control Plane scaffold
      </footer>
    </div>
  );
}
