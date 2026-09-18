"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";

const PLANS = {
  intern: { label: "インターン", setupYen: 150000, monthly: 50000 },
  proper: { label: "プロパー", setupYen: 150000, monthly: 150000 },
  executive: { label: "エグゼクティブ", setupYen: 300000, monthly: 300000 },
} as const;

type PlanKey = keyof typeof PLANS;

function formatPrice(yen: number): string {
  return `¥${yen.toLocaleString("ja-JP")}`;
}

function CheckoutContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const planParam = searchParams.get("plan") || "";
  const fallback = searchParams.get("fallback") === "true";
  const error = searchParams.get("error");

  const [status, setStatus] = useState<"idle" | "loading" | "fallback" | "error">(
    fallback ? "fallback" : "idle"
  );

  const plan = PLANS[planParam as PlanKey] ? (planParam as PlanKey) : null;

  useEffect(() => {
    if (!plan) {
      setStatus("error");
      return;
    }

    if (fallback) {
      setStatus("fallback");
      return;
    }

    if (error) {
      setStatus("error");
      return;
    }

    setStatus("loading");
    fetch(`/api/lp/ai-employee/checkout?plan=${plan}`, {
      method: "GET",
      redirect: "manual",
    })
      .then((res) => {
        if (res.type === "opaqueredirect" || res.redirected) {
          window.location.href = res.url || `/api/lp/ai-employee/checkout?plan=${plan}`;
          return;
        }
        return res.json();
      })
      .then((data) => {
        if (!data) return;
        if (data.fallback) {
          setStatus("fallback");
        } else if (data.url) {
          window.location.href = data.url;
        } else {
          setStatus("error");
        }
      })
      .catch(() => {
        setStatus("error");
      });
  }, [plan, fallback, error, router]);

  if (!plan) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
        <div className="w-full max-w-md surface p-6 md:p-8 text-center">
          <BrandMark size="md" href="/lp/ai-employee" />
          <h1 className="mt-6 text-2xl font-bold tracking-tight">無効なプラン</h1>
          <p className="mt-3 text-sm muted">
            プランが指定されていないか、無効です。
          </p>
          <Link href="/lp/ai-employee" className="btn btn-primary mt-6">
            AI社員パックに戻る
          </Link>
        </div>
      </div>
    );
  }

  const planInfo = PLANS[plan];

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
        <div className="w-full max-w-md surface p-6 md:p-8 text-center">
          <BrandMark size="md" href="/lp/ai-employee" />
          <div className="mt-6">
            <div className="w-12 h-12 mx-auto border-4 border-[var(--border)] border-t-[var(--accent-strong)] rounded-full animate-spin" />
            <h1 className="mt-4 text-lg font-semibold">決済ページを準備中…</h1>
            <p className="mt-2 text-sm muted">
              {planInfo.label}（初期費用 {formatPrice(planInfo.setupYen)}）
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
        <div className="w-full max-w-md surface p-6 md:p-8 text-center">
          <BrandMark size="md" href="/lp/ai-employee" />
          <div className="mt-6">
            <div className="w-16 h-16 mx-auto rounded-full bg-[color-mix(in_oklab,var(--danger)_15%,var(--bg))] flex items-center justify-center">
              <svg
                className="w-8 h-8 text-[var(--danger)]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight">エラーが発生しました</h1>
            <p className="mt-3 text-sm muted">
              決済ページの準備中にエラーが発生しました。
              <br />
              お手数ですが、相談フォームからお問い合わせください。
            </p>
          </div>
          <div className="mt-6 space-y-3">
            <Link
              href={`/lp/ai-employee/consult?plan=${plan}`}
              className="btn btn-primary w-full justify-center"
            >
              相談フォームへ
            </Link>
            <Link href="/lp/ai-employee" className="btn btn-ghost w-full justify-center">
              AI社員パックに戻る
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <BrandMark size="md" href="/lp/ai-employee" />

        <div className="mt-6">
          <span className="chip chip-warn text-xs">決済準備中</span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight">
            {planInfo.label}プラン
          </h1>
        </div>

        <div className="mt-6 p-4 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-soft)]">
          <h2 className="text-sm font-semibold">初期費用（セットアップ・研修）</h2>
          <p className="mt-2 text-3xl font-bold">
            {formatPrice(planInfo.setupYen)}
            <span className="text-sm font-normal muted ml-1">（税抜）</span>
          </p>
          <p className="mt-3 text-xs muted">
            月額 {formatPrice(planInfo.monthly)}/人 は別途ご契約となります。
          </p>
        </div>

        <div className="mt-6 p-4 rounded-xl border border-[color-mix(in_oklab,var(--warn)_40%,var(--border))] bg-[color-mix(in_oklab,var(--warn)_5%,var(--bg))]">
          <p className="text-sm">
            現在、オンライン決済の準備を進めております。
            <br />
            お手数ですが、相談フォームからお申し込みください。
          </p>
        </div>

        <div className="mt-6 space-y-3">
          <Link
            href={`/lp/ai-employee/consult?plan=${plan}`}
            className="btn btn-primary w-full justify-center"
          >
            相談フォームから申し込む
          </Link>
          <Link href="/lp/ai-employee" className="btn btn-ghost w-full justify-center">
            AI社員パックに戻る
          </Link>
        </div>

        <p className="mt-6 text-xs faint text-center">
          決済準備が整い次第、クレジットカードまたは銀行振込でお支払いいただけるようになります。
        </p>

        <LegalLinks className="mt-6 border-t border-[var(--border-soft)] pt-4 text-[11px] faint" />
      </div>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center">
          <div className="w-12 h-12 border-4 border-[var(--border)] border-t-[var(--accent-strong)] rounded-full animate-spin" />
        </div>
      }
    >
      <CheckoutContent />
    </Suspense>
  );
}
