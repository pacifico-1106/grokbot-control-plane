"use client";

import { useState } from "react";
import Link from "next/link";

interface PricingTier {
  id: string;
  name: string;
  tierLabel: string;
  description: string;
  gyomuCapacity: string;
  gyomuCapacityNote?: string;
  examples?: string[];
  monthly: number | null;
  setupFee: number | null;
  popular?: boolean;
  features: string[];
  isCustom?: boolean;
}

const GYOMU_CATALOG = [
  {
    label: "日報・議事録・社内案内の下書き",
    plans: ["intern", "proper", "executive"],
  },
  {
    label: "問い合わせ一次返信・FAQ下書き",
    plans: ["intern", "proper", "executive"],
  },
  {
    label: "予定調整・空き確認",
    plans: ["intern", "proper", "executive"],
  },
  {
    label: "商談メモ整理・フォロー抜け漏れ防止",
    plans: ["proper", "executive"],
    note: "Proper〜",
  },
  {
    label: "週次論点整理・施策たたき台・開発保守の下調べ",
    plans: ["executive"],
    note: "Executive",
  },
];

const PRICING_TIERS: PricingTier[] = [
  {
    id: "intern",
    name: "Intern",
    tierLabel: "インターン",
    description: "定型・一般事務向け",
    gyomuCapacity: "≈ 1業務",
    gyomuCapacityNote: "定型1領域",
    examples: [
      "日報・議事録の下書き",
      "定型メールの下書き",
      "社内案内の下書き・投稿準備",
      "予定の空き確認と候補提示",
      "よくある質問への一次返答案",
    ],
    monthly: 50000,
    setupFee: 150000,
    features: [
      "AI社員証（Staffpass）",
      "会社メール連携",
      "Grok Bot 実行環境",
      "メール / LINE / Slack 承認",
      "基本運用サポート",
      "ハンズオン導入支援",
    ],
  },
  {
    id: "proper",
    name: "Proper",
    tierLabel: "プロパー",
    description: "営業・顧客対応向け",
    gyomuCapacity: "≈ 3業務相当",
    gyomuCapacityNote: "顧客対応など複数定型",
    examples: [
      "問い合わせへの一次返信下書き",
      "見積・提案メモの整理",
      "商談・打合せの日程候補提示",
      "顧客対応ログの要約・日報",
      "フォローアップのリマインド",
    ],
    monthly: 150000,
    setupFee: 150000,
    popular: true,
    features: [
      "Internプランの全機能",
      "複数チャネル対応",
      "カスタム承認フロー",
      "週次レポート",
      "優先サポート",
      "ハンズオン導入支援",
    ],
  },
  {
    id: "executive",
    name: "Executive",
    tierLabel: "エグゼクティブ",
    description: "経営補佐・高度運用（開発保守等）向け",
    gyomuCapacity: "高度運用＋複数",
    gyomuCapacityNote: "開発保守等、個別に業務を設計",
    examples: [
      "経営向けの週次サマリー",
      "複数チャネルの優先度整理",
      "承認ルールの設計と高度な運用",
      "開発・保守の調査と実装案",
      "個別要件に合わせた業務設計の伴走",
    ],
    monthly: 300000,
    setupFee: 300000,
    features: [
      "Properプランの全機能",
      "高度な権限設計",
      "監査ログ詳細出力",
      "専任サポート担当",
      "開発・保守対応",
      "ハンズオン導入支援",
    ],
  },
  {
    id: "custom",
    name: "カスタマイズ",
    tierLabel: "カスタマイズ",
    description: "大規模・特殊要件向け",
    gyomuCapacity: "個別設計",
    gyomuCapacityNote: "複数領域を横断・はみ出す業務",
    monthly: null,
    setupFee: null,
    isCustom: true,
    features: [
      "Executiveプランの全機能",
      "専用環境構築",
      "オンプレミス対応",
      "SLA保証",
      "24/7サポート",
      "カスタム開発",
    ],
  },
];

function formatPrice(amount: number): string {
  return amount.toLocaleString("ja-JP");
}

function calcAnnualMonthly(monthly: number): number {
  return Math.round(monthly * 0.9);
}

function calcAnnualTotal(monthly: number): number {
  return calcAnnualMonthly(monthly) * 12;
}

export function PricingSection() {
  const [isAnnual, setIsAnnual] = useState(false);

  return (
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
          <p className="mt-4 text-base muted leading-relaxed">
            中小企業336万社のミカタ。AI社員プランごとに、任せられる
            <span className="font-semibold text-[var(--text)]">「業務キャパの箱」</span>
            が決まります。
          </p>
          <p className="mt-2 text-sm muted leading-relaxed">
            インターンは1業務、プロパーは3業務相当まで対応。どの業務を任せるかは、
            下の業務カタログを参考に選べます。
            <span className="text-[var(--accent-strong)]">1業務あたり月5万円から</span>
            、インターンプランでスタートできます。
          </p>
        </div>

        {/* Billing Toggle */}
        <div className="mt-8 flex justify-center">
          <div
            className="inline-flex items-center gap-1 p-1 rounded-full border border-[var(--border)] bg-[var(--bg)]"
            role="radiogroup"
            aria-label="支払い方法の選択"
          >
            <button
              type="button"
              role="radio"
              aria-checked={!isAnnual}
              onClick={() => setIsAnnual(false)}
              className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
                !isAnnual
                  ? "bg-[var(--accent-strong)] text-[var(--accent-fg)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              月払い
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isAnnual}
              onClick={() => setIsAnnual(true)}
              className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
                isAnnual
                  ? "bg-[var(--accent-strong)] text-[var(--accent-fg)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              年一括（10%お得）
            </button>
          </div>
        </div>

        {/* Pricing Cards Grid */}
        <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-4 items-stretch">
          {PRICING_TIERS.map((tier) => (
            <article
              key={tier.name}
              className={`surface p-6 sm:p-8 h-full flex flex-col ${
                tier.popular
                  ? "ring-2 ring-[var(--accent-strong)] relative"
                  : ""
              }`}
            >
              {tier.popular && (
                <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 z-10 chip chip-ok text-[10px] px-3 bg-[var(--bg-elevated)] ring-2 ring-[var(--bg-elevated)]">
                  人気
                </span>
              )}

              {/* Plan Name Block */}
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold">{tier.name}</h3>
                  <span className="text-xs text-[var(--text-muted)]">
                    {tier.tierLabel}
                  </span>
                </div>
                <p className="mt-1 text-sm muted">{tier.description}</p>
                {/* 業務キャパ Badge */}
                <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-[var(--accent-strong)]/10 border border-[var(--accent-strong)]/20">
                  <span className="text-xs font-semibold text-[var(--accent-strong)]">
                    {tier.gyomuCapacity}
                  </span>
                  {tier.gyomuCapacityNote && (
                    <span className="text-[10px] text-[var(--text-muted)]">
                      （{tier.gyomuCapacityNote}）
                    </span>
                  )}
                </div>
                {tier.examples && tier.examples.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {tier.examples.map((example) => (
                      <li
                        key={example}
                        className="flex items-start gap-1.5 text-xs text-[var(--text-muted)]"
                      >
                        <span className="text-[var(--accent-strong)] shrink-0">
                          ・
                        </span>
                        {example}
                      </li>
                    ))}
                  </ul>
                )}
                {tier.isCustom && (
                  <p className="mt-3 text-xs text-[var(--text-muted)]">
                    業務範囲はご相談のうえ設計します
                  </p>
                )}
              </div>

              {/* Price Block - consistent height */}
              <div className="mt-4 min-h-[5.5rem]">
                {tier.isCustom ? (
                  <div className="flex items-baseline gap-1">
                    <span className="text-2xl font-bold">個別見積</span>
                  </div>
                ) : tier.monthly ? (
                  <>
                    {isAnnual ? (
                      <>
                        <div className="flex items-baseline gap-1">
                          <span className="text-3xl font-bold text-[var(--accent-strong)]">
                            ¥{formatPrice(calcAnnualMonthly(tier.monthly))}
                          </span>
                          <span className="text-sm muted">/月</span>
                        </div>
                        <p className="mt-1 text-sm">
                          <span className="line-through text-[var(--text-faint)]">
                            ¥{formatPrice(tier.monthly)}/月
                          </span>
                          <span className="ml-2 text-[var(--ok)]">10%オフ</span>
                        </p>
                        <p className="mt-1 text-xs faint">
                          年額 ¥{formatPrice(calcAnnualTotal(tier.monthly))}
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="flex items-baseline gap-1">
                          <span className="text-3xl font-bold">
                            ¥{formatPrice(tier.monthly)}
                          </span>
                          <span className="text-sm muted">/月</span>
                        </div>
                        <p className="mt-2 text-xs faint">
                          年一括なら月あたり ¥
                          {formatPrice(calcAnnualMonthly(tier.monthly))}
                          <span className="ml-1 text-[var(--ok)]">
                            （10%オフ）
                          </span>
                        </p>
                      </>
                    )}
                  </>
                ) : null}
              </div>

              {/* Setup Fee */}
              <div className="mt-2 min-h-[2rem]">
                {tier.setupFee ? (
                  <p className="text-xs faint">
                    初期費用: ¥{formatPrice(tier.setupFee)}（税別）
                  </p>
                ) : tier.isCustom ? (
                  <p className="text-xs faint">初期費用: 個別見積</p>
                ) : null}
              </div>

              {/* Features List - flex-1 to push CTA to bottom */}
              <ul className="mt-4 space-y-2 flex-1">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <span className="text-[var(--ok)] mt-0.5 shrink-0">✓</span>
                    <span className="muted">{feature}</span>
                  </li>
                ))}
              </ul>

              {/* CTA - aligned at bottom */}
              <div className="mt-6 space-y-2">
                {tier.isCustom ? (
                  <Link
                    href={`/lp/ai-employee/consult?plan=${tier.id}`}
                    className="btn btn-ghost w-full justify-center"
                  >
                    相談する
                  </Link>
                ) : (
                  <>
                    <Link
                      href={`/lp/ai-employee/checkout?plan=${tier.id}`}
                      className={`btn w-full justify-center ${
                        tier.popular ? "btn-primary" : "btn-ghost"
                      }`}
                    >
                      初期費用を払って申し込む
                    </Link>
                    <Link
                      href={`/lp/ai-employee/consult?plan=${tier.id}`}
                      className="btn btn-ghost w-full justify-center text-xs"
                    >
                      相談する
                    </Link>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>

        {/* 業務カタログ Section */}
        <div className="mt-12 surface p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-6">
            <div>
              <h3 className="text-lg font-semibold">業務カタログ</h3>
              <p className="mt-1 text-sm muted">
                プランを選ぶ際の参考に。どの業務を任せるか、ここから選べます。
              </p>
            </div>
          </div>
          <div className="space-y-3">
            {GYOMU_CATALOG.map((gyomu) => (
              <div
                key={gyomu.label}
                className="flex items-center justify-between gap-4 py-2 border-b border-[var(--border-soft)] last:border-0"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[var(--ok)]">✓</span>
                  <span className="text-sm">{gyomu.label}</span>
                </div>
                {gyomu.note && (
                  <span className="text-xs text-[var(--accent-strong)] shrink-0">
                    {gyomu.note}〜
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-6 pt-4 border-t border-[var(--border-soft)]">
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              <span className="font-semibold">はみ出す業務・複数領域を横断する業務は？</span>
              <br />
              カスタマイズプランで個別にお見積りします。まずはご相談ください。
            </p>
          </div>
        </div>

        <div className="mt-8 text-center space-y-2">
          <p className="text-sm faint">
            ※ 価格は税別です。Google Workspace・Slackは会社負担でのご契約となります。
          </p>
          <p className="text-sm faint">
            ※ Cursor/Grok Bot、LINE公式アカウント等の従量課金分は実費として別途かかります。
          </p>
        </div>
      </div>
    </section>
  );
}
