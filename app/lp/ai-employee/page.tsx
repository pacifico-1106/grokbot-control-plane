import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";

export const metadata: Metadata = {
  title: "AI社員 導入パック — 中小企業336万社の味方 | Staffpass",
  description:
    "AI社員の導入から運用まで、中小企業の経営者のためのマネージドパック。Staffpass（社員証・許可・記録）、会社メール、Grok Bot をまとめて導入。月5,000円から。",
};

const PRICING_TIERS = [
  {
    name: "定型・一般業務向け",
    description: "日報、議事録、定型返信などの業務",
    monthly: 5000,
    features: [
      "AI社員証（Staffpass）",
      "会社メール連携",
      "Grok Bot 実行環境",
      "メール or LINE 承認",
      "基本運用サポート",
    ],
  },
  {
    name: "営業・事務リード向け",
    description: "顧客対応、見積作成、スケジュール調整",
    monthly: 15000,
    popular: true,
    features: [
      "定型プランの全機能",
      "複数チャネル対応",
      "カスタム承認フロー",
      "週次レポート",
      "優先サポート",
    ],
  },
  {
    name: "経営補佐・高度運用向け",
    description: "経営分析、高度な判断支援、複合タスク",
    monthly: 30000,
    features: [
      "営業・事務プランの全機能",
      "高度な権限設計",
      "監査ログ詳細出力",
      "専任サポート担当",
      "GitHub連携オプション",
    ],
  },
];

const PILLARS = [
  {
    icon: "01",
    title: "Staffpass",
    subtitle: "AI社員の社員証",
    description:
      "誰が、何の目的で、どこまで実行できるかを管理。承認フローと監査記録で、説明できる運用を実現します。",
  },
  {
    icon: "02",
    title: "会社メール",
    subtitle: "Google Workspace連携",
    description:
      "AI社員専用のメールアドレスを発行。会社の名義で送受信し、人が承認してから送信する初期設定で安心。",
  },
  {
    icon: "03",
    title: "Grok Bot",
    subtitle: "AI実行環境",
    description:
      "Cursorベースの実行環境でAI社員が稼働。権限の範囲内で業務を遂行し、Staffpassが最後の砦として制御します。",
  },
];

const STEPS = [
  {
    step: "01",
    title: "ヒアリング・設計",
    description:
      "どんな業務をAI社員に任せたいか、お話を伺います。職務範囲と承認ルールを一緒に設計します。",
  },
  {
    step: "02",
    title: "環境セットアップ",
    description:
      "Staffpassでの社員証発行、Google Workspaceの連携、Grok Bot環境の構築を私たちが行います。",
  },
  {
    step: "03",
    title: "承認チャネル設定",
    description:
      "メールまたはLINEで承認通知を受け取れるよう設定。スマホから承認・却下ができます。",
  },
  {
    step: "04",
    title: "運用開始・サポート",
    description:
      "AI社員が業務を開始。運用プレイブックに沿って、継続的にサポートします。",
  },
];

const FAQ = [
  {
    q: "AI社員とは何ですか？",
    a: "定型業務や顧客対応を自動で行うAIです。ただし「社員証」がないまま使うと、誰が何を許可したか、あとから追えなくなります。Staffpassは、AI社員に社員証を付けて、許可・止め方・記録を残せるようにする製品です。",
  },
  {
    q: "本当に月5,000円から使えるの？",
    a: "はい。定型・一般業務向けのAI社員は月5,000円（税別）です。ただし、Google Workspaceのアカウント費用やGrok Botの従量課金分など、実費は別途かかります。セットアップから運用まで、私たちがサポートします。",
  },
  {
    q: "承認はどうやって行うの？",
    a: "メールまたはLINEで承認依頼が届きます。初期設定では、社外送信・日程確定・発注は人が見るまで進みません。スマホから承認・却下を行えます。",
  },
  {
    q: "勝手にメールを送ったり、予定を入れたりしない？",
    a: "初期設定では、社外送信・日程の確定・発注は人が見るまで進みません。承認フローを経てから実行されます。事業者の判断で自動化することも可能ですが、その場合は警告を確認のうえ、責任は事業者にあります。",
  },
  {
    q: "Google Workspaceを使っていないのですが？",
    a: "Google Workspaceの新規導入からサポートします。AI社員用のメールアドレスを発行し、会社としてのメール運用を始められます。既存のWorkspace環境への追加も対応しています。",
  },
  {
    q: "セキュリティは大丈夫？",
    a: "Staffpassは、AIの実行を会社の外側から制御する仕組みです。権限の範囲外は実行しません。承認履歴と実行ログが監査台帳に残り、あとから誰が何を許可したか追えます。",
  },
  {
    q: "自社のシステム開発やメンテナンスにも使える？",
    a: "将来的には、GitHubリポジトリを接続して、同じ人＋AIの承認ループで開発・保守も回せるようになります。まずは業務運用からスタートし、準備ができ次第ご案内します。",
  },
  {
    q: "解約はいつでもできる？",
    a: "月払いの場合、月末までに解約のご連絡をいただければ翌月から停止できます。年払いの場合は契約期間満了後の解約となります。",
  },
];

function formatPrice(amount: number): string {
  return amount.toLocaleString("ja-JP");
}

function calcAnnualMonthly(monthly: number): number {
  return Math.round(monthly * 0.9);
}

export default function AIEmployeeLP() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] overflow-x-hidden">
      <header className="sticky top-0 z-30 border-b border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <BrandMark size="md" className="min-w-0" />
          <nav className="flex items-center gap-2">
            <Link
              href="/signup"
              className="btn btn-primary text-xs sm:text-sm"
            >
              無料で相談
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-4 sm:px-6 pt-14 sm:pt-20 pb-16 sm:pb-24">
          <div className="max-w-3xl mx-auto text-center">
            <span className="eyebrow">AI EMPLOYEE MANAGED PACK</span>
            <h1 className="mt-5 text-[clamp(2rem,5vw,3.5rem)] font-bold tracking-[-0.045em] leading-[1.1]">
              中小企業336万社の味方
              <br />
              <span className="text-gradient">AI社員 by Staffpass</span>
            </h1>
            <p className="mt-6 text-base sm:text-lg muted leading-relaxed max-w-2xl mx-auto">
              導入から運用まで、まるごとおまかせ。
              <br className="hidden sm:block" />
              AI社員の「社員証」で、許可・止め方・記録を会社に残します。
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/signup" className="btn btn-primary">
                無料で相談する
              </Link>
              <Link href="#pricing" className="btn btn-ghost">
                料金を見る
              </Link>
            </div>
          </div>
        </section>

        {/* Problem */}
        <section className="border-y border-[var(--border-soft)] bg-[var(--bg-elevated)]">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-20">
            <div className="max-w-2xl">
              <span className="eyebrow">なぜAI社員に社員証が必要か</span>
              <h2 className="mt-4 text-2xl sm:text-4xl font-bold tracking-[-0.045em] leading-tight">
                便利なだけでは、
                <br />
                会社として説明できない
              </h2>
              <p className="mt-6 text-base muted leading-relaxed">
                ChatGPTやGrokは便利です。でも、社員が個人で使っていると、誰が何を許可したのか、どこまで任せたのか、あとから追えません。
              </p>
              <p className="mt-4 text-base muted leading-relaxed">
                AI社員に「社員証」を付ければ、会社として説明できる運用になります。権限を分け、承認を残し、記録を追える。それがStaffpassの役割です。
              </p>
            </div>
          </div>
        </section>

        {/* What's Included - 3 Pillars */}
        <section className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
          <div className="max-w-2xl">
            <span className="eyebrow">WHAT&apos;S INCLUDED</span>
            <h2 className="mt-4 text-2xl sm:text-4xl font-bold tracking-[-0.045em] leading-tight">
              セットアップから運用まで
              <br />
              3つの柱でサポート
            </h2>
          </div>
          <div className="mt-10 grid md:grid-cols-3 gap-4">
            {PILLARS.map((pillar) => (
              <article
                key={pillar.title}
                className="surface feature-card p-5 sm:p-6"
              >
                <span className="font-mono text-xs text-[var(--accent-strong)]">
                  {pillar.icon}
                </span>
                <h3 className="mt-8 text-lg font-semibold">{pillar.title}</h3>
                <p className="mt-1 text-sm text-[var(--accent-strong)]">
                  {pillar.subtitle}
                </p>
                <p className="mt-3 text-sm muted leading-relaxed">
                  {pillar.description}
                </p>
              </article>
            ))}
          </div>
          <div className="mt-8 surface p-5 sm:p-6">
            <h3 className="text-base font-semibold">料金に含まれるもの</h3>
            <ul className="mt-4 grid sm:grid-cols-2 gap-x-8 gap-y-2 text-sm muted">
              <li className="flex items-start gap-2">
                <span className="text-[var(--ok)] mt-0.5">✓</span>
                Staffpass社員証の発行・設定
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--ok)] mt-0.5">✓</span>
                Google Workspace連携サポート
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--ok)] mt-0.5">✓</span>
                Grok Bot / Cursor環境の構築
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--ok)] mt-0.5">✓</span>
                承認チャネル設定（メール or LINE）
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--ok)] mt-0.5">✓</span>
                運用プレイブック
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--ok)] mt-0.5">✓</span>
                人による承認ゲート（初期設定）
              </li>
            </ul>
            <div className="mt-6 pt-4 border-t border-[var(--border-soft)]">
              <h4 className="text-sm font-semibold text-[var(--text-muted)]">
                実費は別途
              </h4>
              <p className="mt-2 text-sm faint leading-relaxed">
                Google Workspaceのアカウント費用、Cursor/Grok
                Botの従量課金分、LINE公式アカウント費用（ご利用の場合）は、プラン料金とは別に実費としてかかります。
              </p>
            </div>
          </div>
        </section>

        {/* How it Works */}
        <section className="border-y border-[var(--border-soft)] bg-[var(--bg-elevated)]">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
            <div className="max-w-2xl">
              <span className="eyebrow">HOW IT WORKS</span>
              <h2 className="mt-4 text-2xl sm:text-4xl font-bold tracking-[-0.045em] leading-tight">
                導入から運用まで
                <br />
                私たちがサポート
              </h2>
            </div>
            <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {STEPS.map((item) => (
                <article key={item.step} className="surface p-5 sm:p-6">
                  <span className="font-mono text-xs text-[var(--accent-strong)]">
                    STEP {item.step}
                  </span>
                  <h3 className="mt-4 text-base font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm muted leading-relaxed">
                    {item.description}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Approval Channels */}
        <section className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
          <div className="max-w-2xl mx-auto text-center">
            <span className="eyebrow">APPROVAL CHANNELS</span>
            <h2 className="mt-4 text-2xl sm:text-4xl font-bold tracking-[-0.045em] leading-tight">
              メールまたはLINEで承認
            </h2>
            <p className="mt-6 text-base muted leading-relaxed">
              AI社員が社外送信・日程確定・発注などを行う前に、あなたに承認依頼が届きます。
              <br className="hidden sm:block" />
              スマートフォンから、いつでも承認・却下できます。
            </p>
          </div>
          <div className="mt-10 grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
            <div className="surface p-6 text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-[var(--bg)] border border-[var(--border)] flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-[var(--accent-strong)]"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <h3 className="mt-4 font-semibold">メール承認</h3>
              <p className="mt-2 text-sm muted">
                会社メールに承認依頼が届きます。
                <br />
                ワンクリックで承認・却下。
              </p>
            </div>
            <div className="surface p-6 text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-[var(--bg)] border border-[var(--border)] flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-[var(--ok)]"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M19.365 9.863c.349 0 .63.285.63.631 0 3.517-2.87 6.387-6.387 6.387H8.717l-3.646 3.646c-.313.313-.818.313-1.13 0-.158-.157-.235-.364-.235-.571V6.63c0-.346.282-.63.63-.63h14.03c.346 0 .63.284.63.63v3.233h-.631zm-6.387 5.387c2.863 0 5.19-2.327 5.19-5.19V7.827H5.333v10.973l2.754-2.754h4.891zm-7.117-6.89h12.276v1.26H5.861v-1.26zm0 2.52h8.316v1.26H5.861v-1.26z" />
                </svg>
              </div>
              <h3 className="mt-4 font-semibold">LINE承認</h3>
              <p className="mt-2 text-sm muted">
                LINEに通知が届きます。
                <br />
                外出先でもすぐ対応できます。
              </p>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section
          id="pricing"
          className="border-y border-[var(--border-soft)] bg-[var(--bg-elevated)]"
        >
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
            <div className="max-w-2xl">
              <span className="eyebrow">PRICING</span>
              <h2 className="mt-4 text-2xl sm:text-4xl font-bold tracking-[-0.045em] leading-tight">
                シンプルな料金体系
              </h2>
              <p className="mt-4 text-base muted">
                役割・責任に応じて、月額料金を選べます。
                <br />
                年払いなら10%オフ。
              </p>
            </div>
            <div className="mt-10 grid lg:grid-cols-3 gap-4">
              {PRICING_TIERS.map((tier) => (
                <article
                  key={tier.name}
                  className={`surface p-6 sm:p-8 flex flex-col ${
                    tier.popular
                      ? "ring-2 ring-[var(--accent-strong)] relative"
                      : ""
                  }`}
                >
                  {tier.popular && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 chip chip-ok text-[10px] px-3">
                      人気
                    </span>
                  )}
                  <h3 className="text-lg font-semibold">{tier.name}</h3>
                  <p className="mt-1 text-sm muted">{tier.description}</p>
                  <div className="mt-6">
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-bold">
                        ¥{formatPrice(tier.monthly)}
                      </span>
                      <span className="text-sm muted">/人・月</span>
                    </div>
                    <p className="mt-2 text-xs faint">
                      年払い: ¥{formatPrice(calcAnnualMonthly(tier.monthly))}
                      /人・月
                      <span className="ml-1 text-[var(--ok)]">（10%オフ）</span>
                    </p>
                  </div>
                  <ul className="mt-6 space-y-2 flex-1">
                    {tier.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-sm"
                      >
                        <span className="text-[var(--ok)] mt-0.5">✓</span>
                        <span className="muted">{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/signup"
                    className={`btn mt-6 w-full justify-center ${
                      tier.popular ? "btn-primary" : "btn-ghost"
                    }`}
                  >
                    相談する
                  </Link>
                </article>
              ))}
            </div>
            <p className="mt-8 text-sm faint text-center">
              ※
              価格は税別です。Google Workspace、Cursor/Grok
              Bot、LINE公式アカウント等の実費は別途かかります。
            </p>
          </div>
        </section>

        {/* Future: GitHub */}
        <section className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
          <div className="surface p-6 sm:p-10 max-w-3xl mx-auto">
            <span className="eyebrow">COMING SOON</span>
            <h2 className="mt-4 text-xl sm:text-2xl font-bold tracking-tight">
              GitHubリポジトリ連携で、
              <br className="sm:hidden" />
              開発・保守も同じループに
            </h2>
            <p className="mt-4 text-sm muted leading-relaxed">
              将来的には、GitHubリポジトリを接続することで、業務運用だけでなく、システム開発やメンテナンスも同じ「人＋AI」の承認ループで回せるようになります。コードの調査・実装・レビュー・デプロイを、AI社員と人が協力して進める世界を目指しています。
            </p>
            <p className="mt-3 text-sm faint">
              準備ができ次第、ご案内いたします。
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section
          id="faq"
          className="border-t border-[var(--border-soft)] bg-[var(--bg-elevated)]"
        >
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
            <div className="max-w-2xl">
              <span className="eyebrow">FAQ</span>
              <h2 className="mt-4 text-2xl sm:text-4xl font-bold tracking-[-0.045em] leading-tight">
                よくある質問
              </h2>
            </div>
            <div className="mt-10 max-w-3xl space-y-3">
              {FAQ.map((item) => (
                <details key={item.q} className="group surface p-5 sm:p-6">
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-4 [&::-webkit-details-marker]:hidden">
                    <span className="text-base font-semibold leading-snug">
                      {item.q}
                    </span>
                    <span
                      className="mt-0.5 shrink-0 font-mono text-xs text-[var(--accent-strong)]"
                      aria-hidden="true"
                    >
                      <span className="group-open:hidden">+</span>
                      <span className="hidden group-open:inline">−</span>
                    </span>
                  </summary>
                  <p className="mt-3 text-sm muted leading-relaxed">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
          <div className="surface cta-panel px-5 py-10 sm:p-12 text-center">
            <span className="eyebrow">GET STARTED</span>
            <h2 className="mt-4 text-2xl sm:text-4xl font-bold tracking-tight">
              まずは無料で相談
            </h2>
            <p className="mt-3 text-sm muted max-w-xl mx-auto">
              AI社員の導入に興味があれば、お気軽にご相談ください。
              <br className="hidden sm:block" />
              御社の業務に合った提案をいたします。
            </p>
            <Link href="/signup" className="btn btn-primary mt-7">
              無料で相談する
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--border-soft)]">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-7 flex flex-col gap-4 text-xs faint">
          <LegalLinks />
          <div className="flex flex-col sm:flex-row justify-between gap-2">
            <span>Staffpass by Sealith</span>
            <span>© TOKYO307</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
