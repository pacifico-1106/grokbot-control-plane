"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { TAX_EXCLUSIVE_NOTE_JA } from "@/lib/billing/packs";
import { LegalLinks } from "@/components/LegalLinks";

type Props = {
  hasStripeCustomer?: boolean;
  stripeConfigured?: boolean;
};

export function BillingClient({
  hasStripeCustomer,
  stripeConfigured = false,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const searchParams = useSearchParams();

  const checkoutBanner = useMemo(() => {
    const checkout = searchParams.get("checkout");
    const plan = searchParams.get("plan");
    if (checkout === "success") {
      return {
        kind: "ok" as const,
        text: `お支払いが完了しました${plan ? `（${plan}）` : ""}。まもなく契約状態へ反映されます。`,
      };
    }
    if (checkout === "canceled") {
      return { kind: "warn" as const, text: "お支払いはキャンセルされました" };
    }
    return null;
  }, [searchParams]);

  async function openPortal() {
    setBusy("portal");
    setMessage("");
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || "portal_failed");
      if (body.url) {
        window.location.href = body.url;
        return;
      }
      setMessage(body.message || "契約管理画面は準備中です");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "portal_failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {checkoutBanner ? (
        <div className={`surface mb-4 border-l-4 p-4 text-sm ${checkoutBanner.kind === "ok" ? "border-l-[var(--ok)]" : "border-l-[var(--warn)]"}`}>
          {checkoutBanner.text}
        </div>
      ) : null}

      {!stripeConfigured ? (
        <div className="surface mb-4 border-l-4 border-l-[var(--warn)] p-4">
          <p className="text-sm font-semibold text-[var(--warn)]">オンライン決済は準備中です</p>
          <p className="mt-1 text-xs muted">現在は銀行振込またはお問い合わせでお申し込みいただけます</p>
        </div>
      ) : null}

      {/*
        旧プラン（AI社員 Lite = STRIPE_PRICE_ID_BUSINESS / Standard = STRIPE_PRICE_ID_MANAGED）は
        2026-10-04 に新規申込を終了（AI社員パックへ集約）。購入ボタンは出さない。
        既存契約者は下の「契約内容を管理」（Stripe Billing Portal）で請求書・支払い方法・解約を継続利用できる。
      */}
      <section className="surface p-4 sm:p-5" data-testid="billing-retired-plans-note">
        <h2 className="text-base font-bold">新しくご契約いただく場合</h2>
        <p className="mt-2 text-sm muted leading-relaxed">
          AI社員 Lite / AI社員 Standard の新規のお申し込みは終了しました。新しくご契約いただく場合は
          <Link href="/lp/ai-employee#pricing" className="underline">AI社員パック</Link>
          をお選びください。
        </p>
        <p className="mt-2 text-xs faint leading-relaxed">
          すでにご契約中の方は、これまでどおり「契約内容を管理」から請求書の確認・お支払い方法の変更・解約ができます。
        </p>
      </section>

      {/*
        旧SaaS体系の任意オプション（導入キックオフ ¥300,000 一式・Care ¥80,000/月）は
        現行の AI社員 導入パック（LP・特定商取引法に基づく表記）に存在しないため表示しない。
        初期費用はプランごとに LP / 特商法表記に記載の金額が正。
      */}
      <section className="surface mt-4 p-4 sm:p-5" data-testid="billing-current-pricing-note">
        <h2 className="text-base font-bold">初期費用・料金について</h2>
        <p className="mt-2 text-xs muted leading-relaxed">
          初期費用（セットアップ・研修）を含む現行の料金は、
          <Link href="/lp/ai-employee#pricing" className="underline">料金ページ</Link>
          および
          <Link href="/legal/commercial-transactions" className="underline">特定商取引法に基づく表記</Link>
          をご確認ください。
        </p>
      </section>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] faint">{TAX_EXCLUSIVE_NOTE_JA}</p>
        {stripeConfigured ? (
          <button type="button" className="btn btn-ghost text-xs" disabled={busy === "portal" || !hasStripeCustomer} onClick={() => void openPortal()}>
            {busy === "portal" ? "開いています…" : "契約内容を管理"}
          </button>
        ) : null}
      </div>

      <LegalLinks className="mt-4 text-[11px] faint" />

      {message ? <div className="surface mt-4 border-l-4 border-l-[var(--warn)] p-4 text-sm muted">{message}</div> : null}
    </>
  );
}
