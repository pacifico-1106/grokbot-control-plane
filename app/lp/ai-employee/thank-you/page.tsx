import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";

export const metadata: Metadata = {
  title: "お申し込みありがとうございます | AI社員パック",
  robots: "noindex",
};

const PLANS = {
  intern: { label: "インターン", setupYen: 150000 },
  proper: { label: "プロパー", setupYen: 150000 },
  executive: { label: "エグゼクティブ", setupYen: 300000 },
} as const;

type PlanKey = keyof typeof PLANS;

function formatPrice(yen: number): string {
  return `¥${yen.toLocaleString("ja-JP")}`;
}

export default async function ThankYouPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; session_id?: string }>;
}) {
  const params = await searchParams;
  const planParam = params.plan || "";
  const sessionId = params.session_id || "";

  const plan = PLANS[planParam as PlanKey] ? (planParam as PlanKey) : null;
  const planInfo = plan ? PLANS[plan] : null;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8 text-center">
        <BrandMark size="md" href="/lp/ai-employee" />

        <div className="mt-6">
          <div className="w-16 h-16 mx-auto rounded-full bg-[color-mix(in_oklab,var(--ok)_15%,var(--bg))] flex items-center justify-center">
            <svg
              className="w-8 h-8 text-[var(--ok)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">
            お申し込みありがとうございます
          </h1>
          {planInfo && (
            <p className="mt-2 text-base">
              <span className="font-semibold">{planInfo.label}</span>プラン
              <br />
              <span className="text-sm muted">
                初期費用 {formatPrice(planInfo.setupYen)}（税抜）
              </span>
            </p>
          )}
        </div>

        <div className="mt-6 p-4 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-soft)] text-left">
          <h2 className="text-sm font-semibold">次のステップ</h2>
          <ol className="mt-3 space-y-2 text-sm muted list-decimal list-inside">
            <li>
              担当者（安藤）から1営業日以内にメールでご連絡します
            </li>
            <li>
              セットアップガイドをお送りします
            </li>
            <li>
              Google Workspace / Slack の設定をご案内します
            </li>
            <li>
              環境構築が完了次第、AI社員が稼働を開始します
            </li>
          </ol>
        </div>

        <div className="mt-6 p-4 rounded-xl border border-[var(--border-soft)] text-left">
          <h2 className="text-sm font-semibold">お問い合わせ</h2>
          <p className="mt-2 text-sm muted">
            ご不明点がございましたら、お気軽にご連絡ください。
          </p>
          <p className="mt-2 text-sm">
            <a
              href="mailto:tando@tokyo307inc.com"
              className="text-[var(--accent-strong)] underline"
            >
              tando@tokyo307inc.com
            </a>
          </p>
        </div>

        {sessionId && (
          <p className="mt-4 text-xs faint">
            セッションID: {sessionId.substring(0, 20)}...
          </p>
        )}

        <Link href="/lp/ai-employee" className="btn btn-ghost mt-6">
          AI社員パックのページに戻る
        </Link>

        <LegalLinks className="mt-6 border-t border-[var(--border-soft)] pt-4 text-[11px] faint" />
      </div>
    </div>
  );
}
