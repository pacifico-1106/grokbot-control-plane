"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";

const VALID_PLANS = ["intern", "proper", "executive"] as const;
type PlanKey = (typeof VALID_PLANS)[number];

interface CheckoutInfo {
  plan: string;
  planLabel: string;
  setupAmountExTax: number;
  monthlyAmountExTax: number;
  catalogVersion: string;
  checkoutAvailable: boolean;
  consultUrl: string;
}

function formatPrice(yen: number): string {
  return `¥${yen.toLocaleString("ja-JP")}`;
}

function CheckoutContent() {
  const searchParams = useSearchParams();
  const planParam = searchParams.get("plan") || "";
  const error = searchParams.get("error");

  const [status, setStatus] = useState<
    "loading" | "confirm" | "submitting" | "redirecting" | "fallback" | "error"
  >("loading");
  const [checkoutInfo, setCheckoutInfo] = useState<CheckoutInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");

  const plan = VALID_PLANS.includes(planParam as PlanKey) ? (planParam as PlanKey) : null;

  useEffect(() => {
    if (!plan) {
      setStatus("error");
      setErrorMessage("無効なプランです");
      return;
    }

    if (error) {
      setStatus("error");
      setErrorMessage("エラーが発生しました");
      return;
    }

    async function loadCheckoutInfo() {
      try {
        const res = await fetch(`/api/lp/ai-employee/checkout?plan=${plan}`);
        const data = await res.json();

        if (!res.ok || !data.ok) {
          setStatus("error");
          setErrorMessage(data.message || "情報の取得に失敗しました");
          return;
        }

        setCheckoutInfo(data);

        if (!data.checkoutAvailable) {
          setStatus("fallback");
        } else {
          setStatus("confirm");
        }
      } catch {
        setStatus("error");
        setErrorMessage("ネットワークエラーが発生しました");
      }
    }

    loadCheckoutInfo();
  }, [plan, error]);

  const handleCheckout = useCallback(async () => {
    if (!plan || !checkoutInfo) return;

    setStatus("submitting");

    try {
      const res = await fetch("/api/lp/ai-employee/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        setStatus("error");
        setErrorMessage(data.message || "決済の開始に失敗しました");
        return;
      }

      if (data.fallback) {
        setStatus("fallback");
        return;
      }

      if (data.url) {
        setStatus("redirecting");
        window.location.href = data.url;
      } else {
        setStatus("error");
        setErrorMessage("決済URLの取得に失敗しました");
      }
    } catch {
      setStatus("error");
      setErrorMessage("ネットワークエラーが発生しました");
    }
  }, [plan, checkoutInfo]);

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

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
        <div className="w-full max-w-md surface p-6 md:p-8 text-center">
          <BrandMark size="md" href="/lp/ai-employee" />
          <div className="mt-6">
            <div className="w-12 h-12 mx-auto border-4 border-[var(--border)] border-t-[var(--accent-strong)] rounded-full animate-spin" />
            <h1 className="mt-4 text-lg font-semibold">読み込み中…</h1>
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
              {errorMessage || "決済ページの準備中にエラーが発生しました。"}
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

  if (status === "submitting" || status === "redirecting") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
        <div className="w-full max-w-md surface p-6 md:p-8 text-center">
          <BrandMark size="md" href="/lp/ai-employee" />
          <div className="mt-6">
            <div className="w-12 h-12 mx-auto border-4 border-[var(--border)] border-t-[var(--accent-strong)] rounded-full animate-spin" />
            <h1 className="mt-4 text-lg font-semibold">
              {status === "redirecting" ? "決済ページへ移動中…" : "決済ページを準備中…"}
            </h1>
            {checkoutInfo && (
              <p className="mt-2 text-sm muted">
                {checkoutInfo.planLabel}（初期費用 {formatPrice(checkoutInfo.setupAmountExTax)}）
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (status === "fallback" && checkoutInfo) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
        <div className="w-full max-w-md surface p-6 md:p-8">
          <BrandMark size="md" href="/lp/ai-employee" />

          <div className="mt-6">
            <span className="chip chip-warn text-xs">決済準備中</span>
            <h1 className="mt-3 text-2xl font-bold tracking-tight">
              {checkoutInfo.planLabel}プラン
            </h1>
          </div>

          <div className="mt-6 p-4 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-soft)]">
            <h2 className="text-sm font-semibold">初期費用（セットアップ・研修）</h2>
            <p className="mt-2 text-3xl font-bold">
              {formatPrice(checkoutInfo.setupAmountExTax)}
              <span className="text-sm font-normal muted ml-1">（税別）</span>
            </p>
            <p className="mt-3 text-xs muted">
              月額 {formatPrice(checkoutInfo.monthlyAmountExTax)}/人 は別途ご契約となります。
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
              href={checkoutInfo.consultUrl}
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

  if (status === "confirm" && checkoutInfo) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
        <div className="w-full max-w-md surface p-6 md:p-8">
          <BrandMark size="md" href="/lp/ai-employee" />

          <div className="mt-6">
            <h1 className="text-2xl font-bold tracking-tight">
              {checkoutInfo.planLabel}プラン
            </h1>
            <p className="mt-2 text-sm muted">お申し込み内容をご確認ください</p>
          </div>

          <div className="mt-6 p-4 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-soft)]">
            <h2 className="text-sm font-semibold">初期費用（セットアップ・研修）</h2>
            <p className="mt-2 text-3xl font-bold">
              {formatPrice(checkoutInfo.setupAmountExTax)}
              <span className="text-sm font-normal muted ml-1">（税別）</span>
            </p>
            <p className="mt-3 text-xs muted">
              月額 {formatPrice(checkoutInfo.monthlyAmountExTax)}/人 は別途ご契約となります。
            </p>
          </div>

          <div className="mt-6 space-y-3">
            <button
              onClick={handleCheckout}
              className="btn btn-primary w-full justify-center"
            >
              決済へ進む
            </button>
            <Link
              href={checkoutInfo.consultUrl}
              className="btn btn-ghost w-full justify-center text-sm"
            >
              相談してから決める
            </Link>
            <Link href="/lp/ai-employee" className="btn btn-ghost w-full justify-center text-sm">
              AI社員パックに戻る
            </Link>
          </div>

          <p className="mt-6 text-xs faint text-center">
            「決済へ進む」をクリックすると、Stripe の決済ページに移動します。
            クレジットカードまたは銀行振込でお支払いいただけます。
          </p>

          <LegalLinks className="mt-6 border-t border-[var(--border-soft)] pt-4 text-[11px] faint" />
        </div>
      </div>
    );
  }

  return null;
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
