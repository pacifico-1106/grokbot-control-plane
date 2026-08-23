import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

const FEATURES = [
  {
    title: "社員証",
    body: "誰が・何の仕事で・どこまでやってよいかを、AI社員ごとに決められます。いらなくなれば止められます。",
  },
  {
    title: "社長が止める承認",
    body: "危ない操作は、人が「要対応」で見てから進みます。承認されるまで実行しません。",
  },
  {
    title: "あとから説明できる記録",
    body: "誰が・何の目的で・何をしたかが残るので、共有PCでも「誰が何をしてよいか」を分けて説明できます。",
  },
];

const BENEFITS = [
  "禁止するより、説明できるレールを敷く。",
  "同じパソコンでも、営業のAI社員と経理のAI社員で権限も記録も違う。",
  "Botを分けても安全にはならない（公式も共有コンピュータ）。境界は社員証側へ。",
  "決済や発注の仕組みは外のサービスを使っても、説明責任の台帳は自社側に残す。",
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] overflow-x-hidden">
      <header className="mx-auto max-w-5xl px-4 sm:px-6 py-4 sm:py-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-[max(1rem,env(safe-area-inset-top))]">
        <BrandMark size="md" className="min-w-0" />
        <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <Link href="/app" className="btn btn-ghost text-sm min-h-[44px] flex-1 sm:flex-none">
            ダッシュボード
          </Link>
          <Link href="/signup" className="btn btn-primary text-sm min-h-[44px] flex-1 sm:flex-none">
            トライアル
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 sm:px-6 pb-24">
        <section className="pt-10 sm:pt-16 md:pt-24 max-w-3xl min-w-0">
          <p className="chip mb-6">経営者・管理者向け</p>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight leading-[1.15] break-words">
            AIを入れるな。
            <br />
            AI社員を雇え。
          </h1>
          <p className="mt-6 text-base sm:text-lg muted leading-relaxed break-words">
            権限・承認・記録がついたAI社員を雇う話です。共有PCでも
            <span className="text-[var(--text)]">「誰が何をしてよいか」</span>
            を分けられます。手足は Grok Bot で動きます。
          </p>
          <div className="mt-8 flex flex-col sm:flex-row flex-wrap gap-3">
            <Link href="/signup" className="btn btn-primary w-full sm:w-auto">
              トライアルを始める
            </Link>
            <Link href="/app" className="btn btn-ghost w-full sm:w-auto">
              ダッシュボード見る
            </Link>
          </div>
          <p className="mt-4 text-xs faint break-words">
            発注（例: eSIMなど）も、承認と上限の内側で進められます。
          </p>
        </section>

        <section className="mt-16 sm:mt-20 grid grid-cols-1 md:grid-cols-3 gap-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="surface p-5 min-w-0">
              <h2 className="text-sm font-semibold">{f.title}</h2>
              <p className="mt-3 text-sm muted leading-relaxed break-words">{f.body}</p>
            </div>
          ))}
        </section>

        <section className="mt-16 surface p-5 sm:p-6 md:p-8 min-w-0">
          <h2 className="text-xl font-bold tracking-tight break-words">
            入れ方はふたつ。
          </h2>
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-5 min-w-0">
              <div className="text-sm font-semibold">おまかせ導入</div>
              <p className="mt-2 text-sm muted leading-relaxed break-words">
                こちらで Grok Bot の環境を用意し、Staffpass につないだ状態でお渡しします。
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-5 min-w-0">
              <div className="text-sm font-semibold">今の Grok Bot に載せる</div>
              <p className="mt-2 text-sm muted leading-relaxed break-words">
                いまお使いの Grok Bot をそのまま。社員証・承認・記録だけを Staffpass につなぎます。
              </p>
            </div>
          </div>
        </section>

        <section className="mt-16 max-w-2xl min-w-0">
          <h2 className="text-xl font-bold break-words">経営者・管理者にとっての要点</h2>
          <ul className="mt-4 space-y-3 text-sm muted">
            {BENEFITS.map((line) => (
              <li key={line} className="break-words">「{line}」</li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-[var(--border)] py-8 text-center text-xs faint px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <p>Staffpass · AI社員（Grok Botで動く）</p>
        <p className="mt-2">Sealith by TOKYO307</p>
      </footer>
    </div>
  );
}
