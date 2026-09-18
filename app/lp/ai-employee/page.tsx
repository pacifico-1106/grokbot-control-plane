import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";

export const metadata: Metadata = {
  title: "AI社員 by Staffpass — 中小企業336万社のミカタ",
  description:
    "中小企業336万社のミカタ。AI社員の社員証で、権限・承認・監査を管理。月額5万円から、Cursor/Grok Bot等の実行環境コスト込み。",
  openGraph: {
    title: "AI社員 by Staffpass — 中小企業336万社のミカタ",
    description:
      "中小企業336万社のミカタ。AI社員の社員証で、権限・承認・監査を管理。月額5万円から、Cursor/Grok Bot等の実行環境コスト込み。",
  },
};

interface PricingTier {
  name: string;
  price: string;
  priceNote?: string;
  description: string;
  setupFee: string;
  features: string[];
  highlighted?: boolean;
  isCustom?: boolean;
}

const PRICING_TIERS: PricingTier[] = [
  {
    name: "インターン（Intern）",
    price: "¥50,000",
    priceNote: "/人・月（税別）",
    description: "定型・一般業務向け",
    setupFee: "¥150,000",
    features: [
      "定型業務の自動化",
      "承認通知（メール / LINE / Slack）",
      "監査ログ",
      "Cursor / Grok Bot等 実行環境込み",
    ],
  },
  {
    name: "プロパー（Proper）",
    price: "¥150,000",
    priceNote: "/人・月（税別）",
    description: "営業・事務リード向け",
    setupFee: "¥150,000",
    features: [
      "インターンの全機能",
      "高度な承認ワークフロー",
      "承認通知（メール / LINE / Slack）",
      "優先サポート",
      "Cursor / Grok Bot等 実行環境込み",
    ],
    highlighted: true,
  },
  {
    name: "エグゼクティブ（Executive）",
    price: "¥300,000",
    priceNote: "/人・月（税別）",
    description: "経営補佐・高度運用向け",
    setupFee: "¥300,000",
    features: [
      "プロパーの全機能",
      "経営層向け高度分析",
      "承認通知（メール / LINE / Slack）",
      "専任サポート",
      "Cursor / Grok Bot等 実行環境込み",
    ],
  },
  {
    name: "カスタマイズ",
    price: "個別見積",
    description: "非標準ロール・複数Bot・深い運用",
    setupFee: "要相談",
    features: [
      "複数AI社員の一括管理",
      "独自ワークフロー構築",
      "専用環境構築",
      "SLA保証",
      "オンボーディング支援",
    ],
    isCustom: true,
  },
];

interface FaqItem {
  q: string;
  a: string;
}

const FAQ: FaqItem[] = [
  {
    q: "AI社員とは何ですか？",
    a: "AIに社員証を発行し、権限・承認・監査を管理する仕組みです。Staffpassを通じて、どのAI社員が何の目的で、どこまで実行できるかを会社として管理できます。",
  },
  {
    q: "承認の通知はどこに届きますか？",
    a: "メール・LINE・Slackの3つから選べます。普段お使いのツールで承認依頼を受け取り、その場で承認・却下できます。複数チャネルの併用も可能です。",
  },
  {
    q: "料金に含まれるものは？",
    a: "月額料金には、Staffpassの社員証管理機能に加え、Cursor・Grok Bot等の「手足」となる実行環境コストが含まれています。弊社名義で支払い、パックに含まれます。",
  },
  {
    q: "別途必要な費用はありますか？",
    a: "Google WorkspaceやSlackの席（シート）は、会社が付与するものなので別途会社負担となります。AI社員用のアカウントを会社のワークスペースに追加する形です。",
  },
  {
    q: "初期費用（研修費用）とは？",
    a: "実質的なセットアップ費用です。AI社員の初期設定、権限設計、承認フローの構築、社内への導入支援を含みます。インターン・プロパープランは15万円、エグゼクティブプランは30万円（税別）です。",
  },
  {
    q: "年払いの割引はありますか？",
    a: "年間一括払いで10%オフとなります。長期的なご利用をお考えの場合はお得です。",
  },
  {
    q: "開発・保守も対応していますか？",
    a: "はい、開発・保守も対応可能です。詳細は個別にご相談ください。",
  },
  {
    q: "トライアルはできますか？",
    a: "はい、14日間の無料トライアルをご用意しています。まずは小さく始めて、効果を実感してください。",
  },
  {
    q: "どのAIエージェントに対応していますか？",
    a: "Grok Botに対応中で、ChatGPT・Claude等も順次対応予定です。対応状況は随時更新しています。",
  },
];

function PricingCard({ tier }: { tier: PricingTier }) {
  const cardClass = tier.highlighted
    ? "surface p-5 sm:p-6 flex flex-col ring-2 ring-[var(--accent-strong)]"
    : "surface p-5 sm:p-6 flex flex-col";

  return (
    <article className={cardClass}>
      {tier.highlighted && (
        <span className="self-start chip chip-ok text-[10px] mb-3">人気</span>
      )}
      <h3 className="text-lg font-bold">{tier.name}</h3>
      <p className="mt-1 text-sm muted">{tier.description}</p>

      <div className="mt-4">
        {tier.isCustom ? (
          <span className="text-2xl sm:text-3xl font-bold">{tier.price}</span>
        ) : (
          <>
            <span className="text-2xl sm:text-3xl font-bold">{tier.price}</span>
            <span className="text-sm muted">{tier.priceNote}</span>
          </>
        )}
      </div>

      <div className="mt-3 text-xs faint">
        <span>研修費用（セットアップ）: </span>
        <span className="text-[var(--text)]">{tier.setupFee}</span>
        {!tier.isCustom && <span>（税別）</span>}
      </div>

      <ul className="mt-5 space-y-2 text-sm muted flex-1">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <span className="text-[var(--ok)] mt-0.5">✓</span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <Link
        href={tier.isCustom ? "/signup?plan=custom" : "/signup"}
        className={`btn mt-6 w-full justify-center ${tier.highlighted ? "btn-primary" : "btn-ghost"}`}
      >
        {tier.isCustom ? "お問い合わせ" : "無料で試す"}
      </Link>
    </article>
  );
}

export default function AIEmployeeLP() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-30 border-b border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <BrandMark size="md" className="min-w-0" />
          <nav className="flex items-center gap-2">
            <Link href="/login" className="btn btn-ghost text-xs sm:text-sm">
              ログイン
            </Link>
            <Link href="/signup" className="btn btn-primary text-xs sm:text-sm">
              無料で試す
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-4 sm:px-6 pt-14 sm:pt-20 pb-16 sm:pb-24 text-center">
          <span className="eyebrow">AI社員 by Staffpass</span>
          <h1 className="mt-5 text-[clamp(2rem,5vw,3.5rem)] font-bold tracking-[-0.045em] leading-[1.1]">
            中小企業336万社の
            <br className="sm:hidden" />
            <span className="text-gradient">ミカタ</span>
          </h1>
          <p className="mt-5 max-w-2xl mx-auto text-base sm:text-lg muted leading-relaxed">
            AIに社員証を。権限・承認・監査を一つに。
            <br className="hidden sm:block" />
            承認通知はメール・LINE・Slackに対応。実行環境のコストも込みで、月額5万円から。
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/signup" className="btn btn-primary">
              14日間、無料で試す
            </Link>
            <Link href="#pricing" className="btn btn-ghost">
              料金を見る
            </Link>
          </div>
        </section>

        {/* Value Props */}
        <section className="border-y border-[var(--border-soft)] bg-[var(--bg-elevated)]">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16">
            <div className="grid md:grid-cols-3 gap-6">
              <article className="surface p-5 sm:p-6">
                <span className="font-mono text-xs text-[var(--accent-strong)]">
                  01
                </span>
                <h3 className="mt-6 text-lg font-semibold">権限を分ける</h3>
                <p className="mt-3 text-sm muted leading-relaxed">
                  AI社員ごとに職務と操作範囲を限定。社外メールは下書きまで、社内Slackは自動など、出口の止め方を会社が決めます。
                </p>
              </article>
              <article className="surface p-5 sm:p-6">
                <span className="font-mono text-xs text-[var(--accent-strong)]">
                  02
                </span>
                <h3 className="mt-6 text-lg font-semibold">人が止める</h3>
                <p className="mt-3 text-sm muted leading-relaxed">
                  初期設定では社外送信・日程確定・発注は人が見るまで進みません。承認通知はメール・LINE・Slackから選べます。承認後も、失効した権限では実行しません。
                </p>
              </article>
              <article className="surface p-5 sm:p-6">
                <span className="font-mono text-xs text-[var(--accent-strong)]">
                  03
                </span>
                <h3 className="mt-6 text-lg font-semibold">記録を残す</h3>
                <p className="mt-3 text-sm muted leading-relaxed">
                  目的、承認者、実行結果を一つの監査台帳に残します。あとから追える形で、説明責任を果たせます。
                </p>
              </article>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
          <div className="text-center max-w-2xl mx-auto">
            <span className="eyebrow">PRICING</span>
            <h2 className="mt-4 text-3xl sm:text-4xl font-bold tracking-[-0.045em]">
              シンプルな料金体系
            </h2>
            <p className="mt-4 text-sm muted">
              年間一括払いで10%オフ。すべて税別表示です。
            </p>
          </div>

          <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {PRICING_TIERS.map((tier) => (
              <PricingCard key={tier.name} tier={tier} />
            ))}
          </div>

          {/* What's included / excluded */}
          <div className="mt-12 grid md:grid-cols-2 gap-6">
            <div className="surface p-5 sm:p-6">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <span className="text-[var(--ok)]">✓</span>
                パックに含まれるもの
              </h3>
              <p className="mt-2 text-xs faint">弊社名義で支払い</p>
              <ul className="mt-4 space-y-2 text-sm muted">
                <li className="flex items-start gap-2">
                  <span className="text-[var(--ok)] mt-0.5">•</span>
                  <span>Staffpass社員証管理（権限・承認・監査）</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--ok)] mt-0.5">•</span>
                  <span>
                    Cursor / Grok Bot など「手足」の実行環境コスト
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--ok)] mt-0.5">•</span>
                  <span>運用サポート</span>
                </li>
              </ul>
            </div>

            <div className="surface p-5 sm:p-6">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <span className="text-[var(--warn)]">※</span>
                別途会社負担
              </h3>
              <p className="mt-2 text-xs faint">会社が付与するもの</p>
              <ul className="mt-4 space-y-2 text-sm muted">
                <li className="flex items-start gap-2">
                  <span className="text-[var(--warn)] mt-0.5">•</span>
                  <span>Google Workspaceのシート（AI社員用アカウント）</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--warn)] mt-0.5">•</span>
                  <span>Slackのシート / ワークスペース</span>
                </li>
              </ul>
              <p className="mt-4 text-xs faint">
                ※ 会社のワークスペースにAI社員を追加する形となります
              </p>
            </div>
          </div>

          {/* Setup fee summary */}
          <div className="mt-8 surface p-5 sm:p-6">
            <h3 className="text-base font-semibold">
              初期費用（研修費用＝実質セットアップ）税別
            </h3>
            <div className="mt-4 grid sm:grid-cols-3 gap-4 text-sm">
              <div className="flex justify-between sm:flex-col sm:gap-1">
                <span className="muted">インターン / プロパー</span>
                <span className="font-semibold">¥150,000</span>
              </div>
              <div className="flex justify-between sm:flex-col sm:gap-1">
                <span className="muted">エグゼクティブ</span>
                <span className="font-semibold">¥300,000</span>
              </div>
              <div className="flex justify-between sm:flex-col sm:gap-1">
                <span className="muted">カスタマイズ</span>
                <span className="font-semibold">要相談</span>
              </div>
            </div>
          </div>
        </section>

        {/* Approval Channels */}
        <section className="border-t border-[var(--border-soft)] bg-[var(--bg-elevated)]">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16">
            <div className="text-center max-w-2xl mx-auto">
              <span className="eyebrow">APPROVAL CHANNELS</span>
              <h2 className="mt-4 text-2xl sm:text-3xl font-bold tracking-[-0.045em]">
                承認通知は3つのチャネルから
              </h2>
              <p className="mt-4 text-sm muted">
                普段お使いのツールで承認依頼を受け取り、その場で承認・却下できます
              </p>
            </div>
            <div className="mt-10 grid sm:grid-cols-3 gap-4 max-w-3xl mx-auto">
              <div className="surface p-5 text-center">
                <div className="text-2xl mb-3">✉️</div>
                <h3 className="font-semibold">メール</h3>
                <p className="mt-2 text-sm muted">メールで承認依頼を受け取り、ワンクリックで承認</p>
              </div>
              <div className="surface p-5 text-center">
                <div className="text-2xl mb-3">💬</div>
                <h3 className="font-semibold">LINE</h3>
                <p className="mt-2 text-sm muted">LINEで通知を受け取り、スマホからすぐ承認</p>
              </div>
              <div className="surface p-5 text-center">
                <div className="text-2xl mb-3">🔔</div>
                <h3 className="font-semibold">Slack</h3>
                <p className="mt-2 text-sm muted">Slackチャネルで承認依頼を受け取り、その場で対応</p>
              </div>
            </div>
          </div>
        </section>

        {/* Development note */}
        <section className="border-y border-[var(--border-soft)]">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-12 text-center">
            <p className="text-base muted">
              開発・保守も対応可能です（個別相談）
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
          <div className="max-w-2xl">
            <span className="eyebrow">FAQ</span>
            <h2 className="mt-4 text-3xl sm:text-4xl font-bold tracking-[-0.045em]">
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
                    className="mt-1 shrink-0 font-mono text-xs text-[var(--accent-strong)]"
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
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16 sm:pb-24">
          <div className="surface cta-panel px-5 py-10 sm:p-12 text-center">
            <span className="eyebrow">START NOW</span>
            <h2 className="mt-4 text-2xl sm:text-3xl font-bold tracking-tight">
              中小企業336万社のミカタ
            </h2>
            <p className="mt-3 text-sm muted">
              まずは14日間、無料でお試しください
            </p>
            <Link href="/signup" className="btn btn-primary mt-7">
              無料トライアルを始める
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
