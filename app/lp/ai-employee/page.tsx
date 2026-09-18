import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";
import { PricingSection } from "./PricingSection";

export const metadata: Metadata = {
  title: "AI社員 導入パック — 中小企業336万社の味方 | Staffpass",
  description:
    "AI社員の導入から運用まで、中小企業の経営者のためのマネージドパック。Staffpass（社員証・許可・記録）、会社メール、Grok Bot をまとめて導入。月50,000円から。",
};

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
      "メールまたはLINE、Slackで承認通知を受け取れるよう設定。スマホから承認・却下ができます。",
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
    q: "本当に月50,000円から使えるの？",
    a: "はい。Internプランは月50,000円（税別）です。ただし、Google Workspaceのアカウント費用やGrok Botの従量課金分など、実費は別途かかります。セットアップから運用まで、私たちがハンズオンでサポートします。",
  },
  {
    q: "初期費用と月額の違いは？",
    a: "初期費用はセットアップ・研修費用で、導入時に一度だけお支払いいただきます。月額はAI社員の利用料金で、毎月または年払いでお支払いいただきます。年払いなら月額が10%オフになります。",
  },
  {
    q: "承認はどうやって行うの？",
    a: "メール、LINE、Slackで承認依頼が届きます。初期設定では、社外送信・日程確定・発注は人が見るまで進みません。スマホから承認・却下を行えます。",
  },
  {
    q: "勝手にメールを送ったり、予定を入れたりしない？",
    a: "初期設定では、社外送信・日程の確定・発注は人が見るまで進みません。承認フローを経てから実行されます。事業者の判断で自動化することも可能ですが、その場合は警告を確認のうえ、責任は事業者にあります。",
  },
  {
    q: "Google Workspaceを使っていないのですが？",
    a: "Google Workspaceの新規導入からサポートします。AI社員用のメールアドレスを発行し、会社としてのメール運用を始められます。既存のWorkspace環境への追加も対応しています。Workspace費用は会社負担となります。",
  },
  {
    q: "セキュリティは大丈夫？",
    a: "Staffpassは、AIの実行を会社の外側から制御する仕組みです。権限の範囲外は実行しません。承認履歴と実行ログが監査台帳に残り、あとから誰が何を許可したか追えます。",
  },
  {
    q: "自社のシステム開発やメンテナンスにも使える？",
    a: "はい。エグゼクティブプランでは、開発・保守の調査や実装案を同じ「人＋AI」の承認ループで回せます。実際の実行は人が承認してから行われるため、安心してお任せいただけます。詳細はご相談ください。",
  },
  {
    q: "解約はいつでもできる？",
    a: "月払いの場合、月末までに解約のご連絡をいただければ翌月から停止できます。年払いの場合は契約期間満了後の解約となります。",
  },
];

const YASAKA_LENSES = [
  { label: "Problem", description: "課題の本質を捉える" },
  { label: "Business", description: "事業として成立させる" },
  { label: "Product", description: "使われるものを作る" },
  { label: "Outcome", description: "成果につなげる" },
];

export default function AIEmployeeLP() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] overflow-x-hidden">
      <header className="sticky top-0 z-30 border-b border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <BrandMark size="md" className="min-w-0" />
          <nav className="flex items-center gap-2">
            <Link
              href="/lp/ai-employee/consult"
              className="btn btn-primary text-xs sm:text-sm"
            >
              相談する
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero with AI Character */}
        <section className="mx-auto max-w-6xl px-4 sm:px-6 pt-14 sm:pt-20 pb-16 sm:pb-24">
          <div className="grid lg:grid-cols-[1fr_auto] items-center gap-8 lg:gap-12">
            <div className="max-w-3xl text-center lg:text-left order-2 lg:order-1">
              <span className="eyebrow">AI EMPLOYEE MANAGED PACK</span>
              <h1 className="mt-5 text-[clamp(2rem,5vw,3.5rem)] font-bold tracking-[-0.045em] leading-[1.1]">
                中小企業336万社の味方
                <br />
                <span className="text-gradient">AI社員 by Staffpass</span>
              </h1>
              <p className="mt-6 text-base sm:text-lg muted leading-relaxed max-w-2xl mx-auto lg:mx-0">
                導入から運用まで、まるごとおまかせ。
                <br className="hidden sm:block" />
                AI社員の「社員証」で、許可・止め方・記録を会社に残します。
              </p>
              <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
                <Link href="/lp/ai-employee/consult" className="btn btn-primary">
                  相談する
                </Link>
                <Link href="#pricing" className="btn btn-ghost">
                  料金を見る
                </Link>
              </div>
            </div>

            {/* AI Character - Hero Crew */}
            <div className="hero-crew relative flex items-end justify-center lg:justify-end order-1 lg:order-2">
              <div className="relative">
                <div className="mb-3 rounded-xl border border-[var(--border)] bg-[color-mix(in_oklab,var(--bg-elevated)_92%,transparent)] px-3 py-2 shadow-xl backdrop-blur-md absolute -top-2 -left-4 z-10">
                  <span className="block font-mono text-[8px] tracking-[0.14em] text-[var(--accent-strong)]">
                    PEBBLE CREW
                  </span>
                  <span className="mt-0.5 block text-[10px] muted">
                    READY TO WORK
                  </span>
                </div>
                <div className="crew-character relative h-[160px] w-[160px] sm:h-[200px] sm:w-[200px] lg:h-[240px] lg:w-[240px]">
                  <Image
                    src="/brand/ai-employee-pebble-core.png"
                    alt="StaffpassのオリジナルAIクルーキャラクター"
                    width={240}
                    height={240}
                    priority
                    className="h-full w-full object-contain drop-shadow-[0_18px_30px_rgba(0,0,0,.55)]"
                  />
                  <span className="crew-eye crew-eye-left" aria-hidden="true" />
                  <span
                    className="crew-eye crew-eye-right"
                    aria-hidden="true"
                  />
                </div>
              </div>
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
                承認チャネル設定（メール / LINE / Slack）
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--ok)] mt-0.5">✓</span>
                運用プレイブック
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--ok)] mt-0.5">✓</span>
                人による承認ゲート（初期設定）
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--ok)] mt-0.5">✓</span>
                ハンズオン導入支援
              </li>
            </ul>
            <div className="mt-6 pt-4 border-t border-[var(--border-soft)]">
              <h4 className="text-sm font-semibold text-[var(--text-muted)]">
                実費は別途
              </h4>
              <p className="mt-2 text-sm faint leading-relaxed">
                Google Workspace（会社負担）、Slackワークスペース（会社負担）、Cursor/Grok
                Botの従量課金分、LINE公式アカウント費用（ご利用の場合）は、プラン料金とは別に実費としてかかります。
              </p>
              <p className="mt-2 text-xs faint">
                ※ その他、業務において必要となるアカウントに応じ変動します。
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
              メール・LINE・Slackで承認
            </h2>
            <p className="mt-6 text-base muted leading-relaxed">
              AI社員が社外送信・日程確定・発注などを行う前に、あなたに承認依頼が届きます。
              <br className="hidden sm:block" />
              スマートフォンから、いつでも承認・却下できます。
            </p>
          </div>
          <div className="mt-10 grid sm:grid-cols-3 gap-4 max-w-3xl mx-auto">
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
            <div className="surface p-6 text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-[var(--bg)] border border-[var(--border)] flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-[#4A154B]"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
                </svg>
              </div>
              <h3 className="mt-4 font-semibold">Slack承認</h3>
              <p className="mt-2 text-sm muted">
                Slackに通知が届きます。
                <br />
                チームで承認フローを回せます。
              </p>
            </div>
          </div>
        </section>

        {/* Pricing Section */}
        <PricingSection />

        {/* Expert Supervision - 八坂太洋 */}
        <section className="border-y border-[var(--border-soft)] bg-[var(--bg-elevated)]">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
            <div className="max-w-2xl">
              <span className="eyebrow">EXPERT SUPERVISION</span>
              <h2 className="mt-4 text-2xl sm:text-4xl font-bold tracking-[-0.045em] leading-tight">
                専門家監修
              </h2>
              <p className="mt-4 text-base muted leading-relaxed">
                AIエージェントを前提とした業務設計の専門家が監修しています。
              </p>
            </div>

            <div className="mt-10 grid lg:grid-cols-[280px_1fr] gap-8">
              {/* Profile Card */}
              <div className="surface p-6 text-center lg:text-left">
                <div className="relative w-32 h-32 mx-auto lg:mx-0 rounded-full overflow-hidden border-2 border-[var(--accent-strong)]">
                  <Image
                    src="/lp/ai-employee/tyasaka.png"
                    alt="八坂太洋"
                    width={128}
                    height={128}
                    className="w-full h-full object-cover"
                  />
                </div>
                <h3 className="mt-4 text-lg font-bold">八坂 太洋</h3>
                <p className="mt-1 text-sm text-[var(--accent-strong)]">
                  Taiyo Yasaka
                </p>
                <p className="mt-2 text-xs muted leading-relaxed">
                  トーキョーサンマルナナ株式会社
                  <br />
                  代表取締役 / Founder &amp; Atelier Principal
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <Link
                    href="https://tokyo307inc.com/about/taiyo-yasaka"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost text-xs w-full justify-center"
                  >
                    プロフィールを見る
                  </Link>
                  <Link
                    href="https://www.youtube.com/@tyasaka1106/videos"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost text-xs w-full justify-center"
                  >
                    YouTubeチャンネル
                  </Link>
                </div>
              </div>

              {/* Content Area */}
              <div className="space-y-6">
                {/* Bio */}
                <div className="surface p-6">
                  <h4 className="text-base font-semibold mb-3">経歴・実績</h4>
                  <ul className="space-y-2 text-sm muted leading-relaxed">
                    <li className="flex items-start gap-2">
                      <span className="text-[var(--accent-strong)] mt-0.5 shrink-0">
                        •
                      </span>
                      楽天にて戦略営業を担当。年間取扱高600億円規模、2014年社長賞受賞
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-[var(--accent-strong)] mt-0.5 shrink-0">
                        •
                      </span>
                      民泊EXPOプレミアム、Threesなどのプロダクト開発
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-[var(--accent-strong)] mt-0.5 shrink-0">
                        •
                      </span>
                      現在はAI駆動開発によるMVP支援・新規事業支援を展開
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-[var(--accent-strong)] mt-0.5 shrink-0">
                        •
                      </span>
                      個人事業主・経営者向け、商工会経営指導員向けに生成AIによるアプリ開発の研修・講演を実施
                    </li>
                  </ul>
                </div>

                {/* Design Philosophy */}
                <div>
                  <h4 className="text-base font-semibold mb-3">
                    設計の4つのレンズ
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {YASAKA_LENSES.map((lens) => (
                      <div
                        key={lens.label}
                        className="surface p-4 text-center"
                      >
                        <span className="text-xs font-mono text-[var(--accent-strong)]">
                          {lens.label}
                        </span>
                        <p className="mt-2 text-xs muted">{lens.description}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Speaking Image */}
                <div className="surface p-4 overflow-hidden rounded-xl">
                  <Image
                    src="/lp/ai-employee/ai-business-speaking.webp"
                    alt="八坂太洋による生成AI活用の講演・研修の様子"
                    width={800}
                    height={400}
                    className="w-full h-auto rounded-lg object-cover"
                  />
                  <p className="mt-3 text-xs faint text-center">
                    生成AI活用に関する講演・研修の様子
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
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
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
          <div className="surface cta-panel px-5 py-10 sm:p-12 text-center">
            <span className="eyebrow">GET STARTED</span>
            <h2 className="mt-4 text-2xl sm:text-4xl font-bold tracking-tight">
              まずは相談から
            </h2>
            <p className="mt-3 text-sm muted max-w-xl mx-auto">
              AI社員の導入に興味があれば、お気軽にご相談ください。
              <br className="hidden sm:block" />
              御社の業務に合った提案をいたします。
            </p>
            <div className="mt-7 flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/lp/ai-employee/consult" className="btn btn-primary">
                相談する
              </Link>
              <Link href="#pricing" className="btn btn-ghost">
                料金を見る
              </Link>
            </div>
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
