"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { CheckoutPlanKey } from "@/lib/stripe";
import {
  PLAN_CONFIRM_QUOTAS,
  PLAN_DISPLAY_YEN,
  PLAN_ONBOARDING_YEN,
  PLAN_OVERAGE_YEN,
  PRICING_PROVISIONAL_NOTE_JA,
  formatYenJa,
} from "@/lib/billing/plans";
import {
  KICKOFF_PACK_LINES,
  KICKOFF_PACK_NOTE_JA,
  KICKOFF_PACK_YEN,
  SUBSIDY_COMING_SOON_JA,
  SUBSIDY_COMPLIANCE_NOTE_JA,
} from "@/lib/billing/skus";

const PLANS: Array<{
  id: CheckoutPlanKey;
  name: string;
  points: string[];
  featured?: boolean;
  quota: number;
  displayYen: number;
  overageYen: number;
  onboardingYen?: number;
  onboardingNote?: string;
}> = [
  {
    id: "starter",
    name: "スターター",
    points: ["少人数で始める基本統制", "承認と監査ログ", "メール通知"],
    quota: PLAN_CONFIRM_QUOTAS.starter,
    displayYen: PLAN_DISPLAY_YEN.starter,
    overageYen: PLAN_OVERAGE_YEN.starter,
  },
  {
    id: "business",
    name: "ビジネス",
    points: ["承認・監査・職務分離", "チーム権限管理", "確定アクション計測"],
    featured: true,
    quota: PLAN_CONFIRM_QUOTAS.business,
    displayYen: PLAN_DISPLAY_YEN.business,
    overageYen: PLAN_OVERAGE_YEN.business,
    onboardingYen: PLAN_ONBOARDING_YEN.business,
  },
  {
    id: "managed",
    name: "Managed",
    points: ["Businessの全機能", "導入代行・週次ヘルス", "要再連携の一次対応"],
    quota: PLAN_CONFIRM_QUOTAS.managed,
    displayYen: PLAN_DISPLAY_YEN.managed,
    overageYen: PLAN_OVERAGE_YEN.managed,
    onboardingNote: "オンボーディング込み",
  },
];

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

  async function checkout(planKey: CheckoutPlanKey) {
    setBusy(planKey);
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
            <h2 className="text-base font-bold">プランを選ぶ</h2>
            <p className="mt-1 text-xs muted">AI社員の人数と運用体制に合わせて選択</p>
          </div>
          <span className="chip w-fit text-[10px]">{PRICING_PROVISIONAL_NOTE_JA}</span>
        </header>

        <div className="p-3 sm:p-4">
          <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <article
                key={plan.id}
                className={`flex h-full min-w-0 flex-col rounded-2xl border bg-[var(--bg)] p-5 ${plan.featured ? "border-[color-mix(in_oklab,var(--accent-strong)_58%,var(--border))] shadow-[0_0_24px_var(--accent-glow)]" : "border-[var(--border-soft)]"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--text-faint)]">{plan.id}</span>
                    <h3 className="mt-1 text-lg font-bold">{plan.name}</h3>
                  </div>
                  {plan.featured ? <span className="chip chip-ok text-[10px]">おすすめ</span> : null}
                </div>

                <p className="mt-5 text-3xl font-bold tracking-tight">
                  {formatYenJa(plan.displayYen)}
                  <span className="ml-1 text-xs font-semibold muted">/ 月</span>
                </p>

                <dl className="mt-5 min-h-[108px] space-y-2 border-y border-[var(--border-soft)] py-4 text-xs">
                  <div className="flex justify-between gap-3"><dt className="muted">確定アクション</dt><dd>{plan.quota.toLocaleString("ja-JP")}回 / 月</dd></div>
                  <div className="flex justify-between gap-3"><dt className="muted">枠超過</dt><dd>{formatYenJa(plan.overageYen)} / 回</dd></div>
                  {plan.onboardingYen != null ? (
                    <div className="flex justify-between gap-3"><dt className="muted">初回導入</dt><dd>{formatYenJa(plan.onboardingYen)}</dd></div>
                  ) : null}
                  {plan.onboardingNote ? (
                    <div className="flex justify-between gap-3"><dt className="muted">初回導入</dt><dd>{plan.onboardingNote}</dd></div>
                  ) : null}
                </dl>

                <ul className="mt-5 flex-1 space-y-2 text-sm muted">
                  {plan.points.map((point) => <li key={point} className="flex gap-2"><span className="text-[var(--ok)]">✓</span><span>{point}</span></li>)}
                </ul>

                <div className="mt-auto pt-6">
                  <button
                    type="button"
                    className={`btn min-h-12 w-full text-sm ${stripeConfigured ? "btn-primary" : "btn-ghost opacity-60 cursor-not-allowed"}`}
                    disabled={!stripeConfigured || busy === plan.id}
                    aria-disabled={!stripeConfigured}
                    onClick={() => void checkout(plan.id)}
                  >
                    {busy === plan.id ? "準備中…" : stripeConfigured ? "お支払いに進む" : "オンライン決済 準備中"}
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

      <section className="surface mt-4 overflow-hidden">
        <header className="border-b border-[var(--border)] px-4 py-4 sm:px-5">
          <h2 className="text-base font-bold">導入支援</h2>
          <p className="mt-1 text-xs muted">必要な場合だけ追加できます</p>
        </header>
        <div className="grid gap-3 p-3 sm:p-4 lg:grid-cols-2">
          <article className="rounded-2xl border border-[var(--border-soft)] bg-[var(--bg)] p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold">キックオフパック</h3>
              <span className="chip text-[10px]">任意</span>
            </div>
            <p className="mt-3 text-2xl font-bold">{formatYenJa(KICKOFF_PACK_YEN)}<span className="ml-1 text-xs muted">一式</span></p>
            <p className="mt-3 text-xs muted leading-relaxed">{KICKOFF_PACK_NOTE_JA}</p>
            <details className="mt-4 border-t border-[var(--border-soft)] pt-3">
              <summary className="cursor-pointer text-xs font-semibold">内訳を見る</summary>
              <ul className="mt-3 space-y-2 text-xs muted">
                {KICKOFF_PACK_LINES.map((line) => (
                  <li key={line.key} className="flex justify-between gap-3"><span>{line.labelJa}</span><span className="shrink-0">{formatYenJa(line.yen)}</span></li>
                ))}
              </ul>
            </details>
          </article>

          <article className="rounded-2xl border border-[var(--border-soft)] bg-[var(--bg)] p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold">補助金関連のご相談</h3>
              <span className="chip text-[10px]">準備中</span>
            </div>
            <p className="mt-3 text-sm muted leading-relaxed">{SUBSIDY_COMING_SOON_JA}</p>
            <p className="mt-3 text-xs faint leading-relaxed">{SUBSIDY_COMPLIANCE_NOTE_JA}</p>
          </article>
        </div>
      </section>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] faint">課金対象はGatewayを通って成功した確定アクションのみです</p>
        {stripeConfigured ? (
          <button type="button" className="btn btn-ghost text-xs" disabled={busy === "portal" || !hasStripeCustomer} onClick={() => void openPortal()}>
            {busy === "portal" ? "開いています…" : "契約内容を管理"}
          </button>
        ) : null}
      </div>

      {message ? <div className="surface mt-4 border-l-4 border-l-[var(--warn)] p-4 text-sm muted">{message}</div> : null}
    </>
  );
}
