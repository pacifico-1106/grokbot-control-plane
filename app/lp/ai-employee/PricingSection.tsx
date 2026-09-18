"use client";

import { useState } from "react";
import Link from "next/link";

interface PricingTier {
  name: string;
  tierLabel: string;
  description: string;
  monthly: number | null;
  setupFee: number | null;
  popular?: boolean;
  features: string[];
  isCustom?: boolean;
}

const PRICING_TIERS: PricingTier[] = [
  {
    name: "Intern",
    tierLabel: "インターン",
    description: "定型業務・一般事務向け",
    monthly: 50000,
    setupFee: 50000,
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
    name: "Proper",
    tierLabel: "プロパー",
    description: "営業・顧客対応向け",
    monthly: 150000,
    setupFee: 100000,
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
    name: "Executive",
    tierLabel: "エグゼクティブ",
    description: "経営補佐・高度運用向け",
    monthly: 300000,
    setupFee: 200000,
    features: [
      "Properプランの全機能",
      "高度な権限設計",
      "監査ログ詳細出力",
      "専任サポート担当",
      "GitHub連携オプション",
      "ハンズオン導入支援",
    ],
  },
  {
    name: "カスタマイズ",
    tierLabel: "カスタマイズ",
    description: "大規模・特殊要件向け",
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
          <p className="mt-4 text-base muted">
            中小企業336万社のミカタ。役割・責任に応じて、月額料金を選べます。
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
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 chip chip-ok text-[10px] px-3">
                  人気
                </span>
              )}

              {/* Plan Name Block - consistent height */}
              <div className="min-h-[4.5rem]">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold">{tier.name}</h3>
                  <span className="text-xs text-[var(--text-muted)]">
                    {tier.tierLabel}
                  </span>
                </div>
                <p className="mt-1 text-sm muted">{tier.description}</p>
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
              <Link
                href="/signup"
                className={`btn mt-6 w-full justify-center ${
                  tier.popular ? "btn-primary" : "btn-ghost"
                }`}
              >
                {tier.isCustom ? "お問い合わせ" : "相談する"}
              </Link>
            </article>
          ))}
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
