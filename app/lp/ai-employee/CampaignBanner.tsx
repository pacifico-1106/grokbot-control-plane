// Temporary: early-bird 100 slots — remove when campaign ends

import Link from "next/link";

export function CampaignBanner() {
  return (
    <div
      role="region"
      aria-label="キャンペーン情報"
      className="border-b border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--accent-strong)_8%,var(--bg))]"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-2.5 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 text-center">
        <p className="text-sm font-semibold text-[var(--accent-strong)]">
          先行100枠｜セットアップ開始は12月以降
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          枠に達し次第、受付を終了します。
        </p>
        <Link
          href="#pricing"
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border border-[color-mix(in_oklab,var(--accent-strong)_40%,var(--border))] text-[var(--accent-strong)] hover:bg-[color-mix(in_oklab,var(--accent-strong)_12%,transparent)] transition-colors"
        >
          料金を見る
          <svg
            className="w-3 h-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </Link>
      </div>
    </div>
  );
}
