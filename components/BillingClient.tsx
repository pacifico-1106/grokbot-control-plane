"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { CheckoutPlanKey } from "@/lib/stripe";
import Link from "next/link";
import {
  CUSTOMER_PACKS,
  TAX_EXCLUSIVE_NOTE_JA,
  formatYenJa,
  type PackId,
} from "@/lib/billing/packs";
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
  const [referralCode, setReferralCode] = useState("");
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

  async function checkout(packId: PackId) {
    const pack = CUSTOMER_PACKS.find((p) => p.id === packId);
    if (!pack) return;
    const planKey: CheckoutPlanKey = pack.backendSku;
    setBusy(packId);
    setMessage("");
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planKey,
          referral_code: referralCode.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || "checkout_failed");
      if (body.url) {
        window.location.href = body.url;
        return;
      }
      setMessage(body.message || "オンライン決済は準備中です");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "checkout_failed");
    } finally {
      setBusy(null);
    }
  }

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

      <section className="surface overflow-hidden">
        <header className="flex flex-col gap-2 border-b border-[var(--border)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <h2 className="text-base font-bold">パックを選ぶ</h2>
            <p className="mt-1 text-xs muted">AI社員の人数と運用体制に合わせて選択</p>
          </div>
          <span className="chip w-fit text-[10px]">{TAX_EXCLUSIVE_NOTE_JA}</span>
        </header>

        <div className="p-3 sm:p-4">
          <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-2">
            {CUSTOMER_PACKS.map((pack) => (
              <article
                key={pack.id}
                className={`flex h-full min-w-0 flex-col rounded-2xl border bg-[var(--bg)] p-5 ${pack.featured ? "border-[color-mix(in_oklab,var(--accent-strong)_58%,var(--border))] shadow-[0_0_24px_var(--accent-glow)]" : "border-[var(--border-soft)]"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold">{pack.displayName}</h3>
                    <span className="text-xs muted">{pack.scaleNote}</span>
                  </div>
                  {pack.featured ? <span className="chip chip-ok text-[10px]">おすすめ</span> : null}
                </div>

                <p className="mt-5 text-3xl font-bold tracking-tight">
                  {formatYenJa(pack.monthlyYen)}
                  <span className="ml-1 text-xs font-semibold muted">/ 月</span>
                </p>

                <ul className="mt-5 flex-1 space-y-2 text-sm muted border-y border-[var(--border-soft)] py-4">
                  {pack.points.map((point) => (
                    <li key={point} className="flex gap-2">
                      <span className="text-[var(--ok)]">✓</span>
                      <span>{point}</span>
                    </li>
                  ))}
                  <li className="flex gap-2">
                    <span className="text-[var(--ok)]">✓</span>
                    <span>手足（Grok Bot）込み</span>
                  </li>
                </ul>

                <div className="mt-auto pt-6">
                  <button
                    type="button"
                    className={`btn min-h-12 w-full text-sm ${stripeConfigured ? "btn-primary" : "btn-ghost opacity-60 cursor-not-allowed"}`}
                    disabled={!stripeConfigured || busy === pack.id}
                    aria-disabled={!stripeConfigured}
                    onClick={() => void checkout(pack.id)}
                  >
                    {busy === pack.id ? "準備中…" : stripeConfigured ? "お支払いに進む" : "オンライン決済 準備中"}
                  </button>
                </div>
              </article>
            ))}
          </div>

          <details className="mt-4 rounded-xl border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
            <summary className="cursor-pointer text-xs font-semibold">紹介コードをお持ちの方</summary>
            <label className="mt-3 block max-w-sm text-xs">
              <span className="muted">紹介コード</span>
              <input
                type="text"
                value={referralCode}
                onChange={(e) => setReferralCode(e.target.value)}
                placeholder="AIC-XXXX"
                autoComplete="off"
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2 text-sm outline-none focus:border-[var(--accent-strong)]"
              />
            </label>
          </details>
        </div>
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
