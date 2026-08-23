import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

const FEATURES = [
  {
    title: "社員証",
    body: "誰が・何の仕事で・どこまでやってよいかを、AI社員ごとに決められます。いらなくなれば止められます。",
  },
  {
    title: "社長が止める承認",
    body: "送る・払う・消すなど危ない操作は、人が「要対応」で見てから進みます。承認されるまで実行しません。",
  },
  {
    title: "あとから説明できる記録",
    body: "誰が・何の目的で・何をしたかが台帳に残るので、上司や取締役会にも説明できます。",
  },
];

const GAP_POINTS = [
  {
    title: "共有のパソコン・共有のログイン",
    body: "手足のエージェントは、同じ実行環境のファイルやログインを共有することがあります。Botを分けても、それだけでは会社の境界にはなりません。誰が何をしてよいかを、別の層で決める必要があります。",
  },
  {
    title: "職務と上限を付けにくい",
    body: "営業のAI社員と経理のAI社員で、権限も使える金額も違うはずです。手足だけでは「この子はここまで」を会社の言葉で割り当てにくい。",
  },
  {
    title: "確定操作に人の門がない",
    body: "送る・払う・消すといった取り返しのつかない操作に、組織としての承認ゲートが欲しい。個人の「お願い」だけでは足りません。",
  },
  {
    title: "あとから説明できる台帳がない",
    body: "社長や取締役会に「誰が・何目的で・何をしたか」を説明できる記録が要る。チャットの記憶に頼れません。",
  },
];

const STAFFPASS_FILLS = [
  {
    title: "社員証（誰が・何の仕事で・どこまで）",
    body: "AI社員ごとに職務と範囲を決め、いらなくなれば止められます。",
  },
  {
    title: "社長が止める承認",
    body: "危ない操作は人が見てから。承認されるまで実行しません。",
  },
  {
    title: "あとから説明できる台帳",
    body: "誰が・何目的で・何をしたかが残り、上司や取締役会にも渡せます。",
  },
  {
    title: "使いすぎを抑える上限",
    body: "AI社員ごとに使える金額の上限を決め、レールの内側で進めます。",
  },
];

const BENEFITS = [
  "禁止するより、説明できるレールを敷く。",
  "同じパソコンでも、営業のAI社員と経理のAI社員で権限も記録も違う。",
  "Sealith の Staffpass は就業規則と日報。手足のエージェント基盤は差し替え可能。",
  "決済や発注の仕組みは外のサービスを使っても、説明責任の台帳は自社側に残す。",
];

const AGENTS = [
  {
    id: "grok",
    name: "Grok Bot",
    subtitle: null as string | null,
    status: "available" as const,
    note: "いまの標準（本線）",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    subtitle: "OpenAI",
    status: "soon" as const,
    note: "Coming soon",
  },
  {
    id: "claude",
    name: "Claude",
    subtitle: "Anthropic",
    status: "soon" as const,
    note: "Coming soon",
  },
  {
    id: "jurin",
    name: "Jurin",
    subtitle: "AIコンシェル／電話入口",
    status: "soon" as const,
    note: "Coming soon",
  },
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
            <span className="text-[var(--text)]">Grok Bot</span>
            は、自分専用のクラウドパソコンを持ち、ブラウザや実アプリの中で動き、依頼を端から端まで仕上げ、24時間働き、始めやすく、判断が必要なときは個人の Auto-review
            で戻ってきます。ChatGPT や Claude
            なども、手足としての実行力は同じように強い。足りないのは会社側の制御です。
            <span className="text-[var(--text)]">Sealith の Staffpass</span>
            は、権限・承認・記録がついた AI社員の就業規則と日報。どの手足を使うかにかかわらず、まず{" "}
            <span className="text-[var(--text)]">Grok Bot</span>
            から本線対応しています。
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
          aria-labelledby="gap-heading"
          className="mt-16 sm:mt-20 max-w-3xl min-w-0"
        >
          <h2
            id="gap-heading"
            className="text-xl sm:text-2xl font-bold tracking-tight break-words"
          >
            なぜ手足だけでは足りないか
          </h2>
          <p className="mt-3 text-sm muted leading-relaxed break-words">
            実行が強いほど、会社としての穴も同じ形で残ります。Grok に限らず、どのエージェント基盤でも次が足りません。
          </p>
          <ul className="mt-6 space-y-4 list-none p-0 m-0">
            {GAP_POINTS.map((item) => (
              <li
                key={item.title}
                className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 sm:p-5 min-w-0"
              >
                <h3 className="text-sm font-semibold tracking-tight break-words">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm muted leading-relaxed break-words">
                  {item.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="fill-heading"
          className="mt-16 sm:mt-20 max-w-3xl min-w-0"
        >
          <h2
            id="fill-heading"
            className="text-xl sm:text-2xl font-bold tracking-tight break-words"
          >
            Staffpass / Sealith が埋めること
          </h2>
          <p className="mt-3 text-sm muted leading-relaxed break-words">
            <span className="text-[var(--text)]">Sealith の Staffpass</span>
            は、その穴を埋める制御面です。手足がどれだけ優秀でも、「誰が・どこまで・人が止める・あとで説明できる」を会社の言葉で持てます。まず
            Grok Bot。他の手足は順次。
          </p>
          <ul className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3 list-none p-0 m-0">
            {STAFFPASS_FILLS.map((item) => (
              <li key={item.title} className="surface p-4 sm:p-5 min-w-0">
                <h3 className="text-sm font-semibold tracking-tight break-words">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm muted leading-relaxed break-words">
                  {item.body}
                </p>
              </li>
            ))}
          </ul>
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
              まず Grok Bot（本線）。他は順次。まだつながっていません。
            </p>
          </div>

          <ul className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3 list-none p-0 m-0">
            {AGENTS.map((agent) => {
              const available = agent.status === "available";
              return (
                <li
                  key={agent.id}
                  className={[
                    "rounded-xl border p-4 sm:p-5 min-w-0 flex flex-col gap-2",
                    available
                      ? "border-[var(--border)] bg-[var(--bg-elevated)]"
                      : "border-[var(--border-soft)] bg-[var(--bg)] opacity-55 pointer-events-none select-none",
                  ].join(" ")}
                >
                  <div className="min-w-0 flex flex-col gap-0.5">
                    <span
                      className={[
                        "text-sm font-semibold tracking-tight break-words leading-snug",
                        available ? "text-[var(--text)]" : "text-[var(--text-faint)]",
                      ].join(" ")}
                    >
                      {agent.name}
                    </span>
                    {agent.subtitle ? (
                      <span className="text-[11px] faint break-words leading-snug">
                        {agent.subtitle}
                      </span>
                    ) : null}
                  </div>
                  <span
                    className={[
                      "mt-auto inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide",
                      available
                        ? "bg-[color-mix(in_srgb,var(--ok)_18%,transparent)] text-[var(--ok)]"
                        : "bg-[var(--bg-soft)] text-[var(--text-faint)] border border-[var(--border-soft)]",
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
        <p>Sealith の Staffpass · 就業規則と日報（エージェント基盤は差し替え可能）</p>
        <p className="mt-2">Sealith by TOKYO307</p>
      </footer>
    </div>
  );
}
