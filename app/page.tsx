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
  "Staffpass は就業規則と日報。手足のエージェント基盤は差し替え可能。",
  "決済や発注の仕組みは外のサービスを使っても、説明責任の台帳は自社側に残す。",
];

const AGENTS = [
  { id: "grok", name: "Grok Bot", status: "available" as const, note: "利用可能" },
  { id: "jurin", name: "Jurin", status: "soon" as const, note: "Coming soon" },
  { id: "slot-a", name: "順次追加", status: "slot" as const, note: "順次追加" },
  { id: "slot-b", name: "順次追加", status: "slot" as const, note: "順次追加" },
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
            権限・承認・記録がついたAI社員を雇う話です。
            <span className="text-[var(--text)]">Staffpass</span>
            は就業規則と日報（制御面）。手足のエージェント基盤は差し替え可能で、まず{" "}
            <span className="text-[var(--text)]">Grok Bot</span>
            に対応しています。共有PCでも
            <span className="text-[var(--text)]">「誰が何をしてよいか」</span>
            を分けられます。
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

        <section
          aria-labelledby="agents-heading"
          className="mt-16 sm:mt-20 min-w-0"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between min-w-0">
            <div className="min-w-0">
              <p className="text-xs faint tracking-wide">対応ランタイム</p>
              <h2
                id="agents-heading"
                className="text-xl font-bold tracking-tight break-words mt-1"
              >
                対応エージェント
              </h2>
            </div>
            <p className="text-sm muted break-words max-w-md">
              まず Grok Bot に対応。他のエージェント基盤は順次。
            </p>
          </div>

          <ul className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3 list-none p-0 m-0">
            {AGENTS.map((agent) => {
              const available = agent.status === "available";
              return (
                <li
                  key={agent.id}
                  className={[
                    "rounded-xl border p-4 sm:p-5 min-w-0 flex flex-col gap-2 sm:gap-3",
                    available
                      ? "border-[var(--border)] bg-[var(--bg-elevated)]"
                      : "border-[var(--border-soft)] bg-[var(--bg)] opacity-55",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "text-sm font-semibold tracking-tight break-words leading-snug",
                      available ? "text-[var(--text)]" : "text-[var(--text-faint)]",
                    ].join(" ")}
                  >
                    {agent.name}
                  </span>
                  <span
                    className={[
                      "text-[11px] tracking-wide",
                      available ? "text-[var(--ok)]" : "text-[var(--text-faint)]",
                    ].join(" ")}
                  >
                    {agent.note}
                  </span>
                </li>
              );
            })}
          </ul>
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
                こちらで実行環境（まず Grok Bot）を用意し、Staffpass
                につないだ状態でお渡しします。
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-5 min-w-0">
              <div className="text-sm font-semibold">今の Grok Bot に載せる</div>
              <p className="mt-2 text-sm muted leading-relaxed break-words">
                いまお使いの Grok Bot
                をそのまま。社員証・承認・記録だけを Staffpass につなぎます。
              </p>
            </div>
          </div>
        </section>

        <section className="mt-16 max-w-2xl min-w-0">
          <h2 className="text-xl font-bold break-words">経営者・管理者にとっての要点</h2>
          <ul className="mt-4 space-y-3 text-sm muted">
            {BENEFITS.map((line) => (
              <li key={line} className="break-words">
                「{line}」
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-[var(--border)] py-8 text-center text-xs faint px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <p>Staffpass · 就業規則と日報（エージェント基盤は差し替え可能）</p>
        <p className="mt-2">Sealith by TOKYO307</p>
      </footer>
    </div>
  );
}
