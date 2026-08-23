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
  KICKOFF_GROK_BAND_JA,
  KICKOFF_PACK_LINES,
  KICKOFF_PACK_NOTE_JA,
  KICKOFF_PACK_YEN,
  MANAGED_BUNDLE_NOTE_JA,
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
  bundleNote?: string;
}> = [
  {
    id: "starter",
    name: "スターター",
    points: [
      "AI社員 少数・基本の就業規則",
      "基本監査（日報の入口）",
      "メール通知",
      "propose / draft 中心",
    ],
    quota: PLAN_CONFIRM_QUOTAS.starter,
    displayYen: PLAN_DISPLAY_YEN.starter,
    overageYen: PLAN_OVERAGE_YEN.starter,
  },
  {
    id: "business",
    name: "ビジネス",
    points: [
      "就業規則と日報（承認・監査）",
      "承認キュー・監査タイムライン",
      "チーム（職務・権限）",
      "確定アクションの従量メーター",
    ],
    featured: true,
    quota: PLAN_CONFIRM_QUOTAS.business,
    displayYen: PLAN_DISPLAY_YEN.business,
    overageYen: PLAN_OVERAGE_YEN.business,
    onboardingYen: PLAN_ONBOARDING_YEN.business,
  },
  {
    id: "managed",
    name: "Managed（Care）",
    points: [
      "Business 全部＋専任伴走（Care）",
      "導入代行・週次ヘルス",
      "要再連携の一次対応",
      "確定枠は厚め（仮枠）",
    ],
    quota: PLAN_CONFIRM_QUOTAS.managed,
    displayYen: PLAN_DISPLAY_YEN.managed,
    overageYen: PLAN_OVERAGE_YEN.managed,
    onboardingNote: "オンボーディングは月額に含む",
    bundleNote: MANAGED_BUNDLE_NOTE_JA,
  },
];

type Props = {
  currentPlan?: string;
  currentStatus?: string;
  hasStripeCustomer?: boolean;
};

export function BillingClient({
  currentPlan,
  currentStatus,
  hasStripeCustomer,
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
        text: `Checkout が完了しました${plan ? `（${plan}）` : ""}。Webhook 同期後にプラン状態が更新されます。`,
      };
    }
    if (checkout === "canceled") {
      return {
        kind: "warn" as const,
        text: "Checkout がキャンセルされました。必要なら再度プランを選択してください。",
      };
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
        body: JSON.stringify({ planKey }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || "checkout_failed");
      if (body.url) {
        window.location.href = body.url;
        return;
      }
      setMessage(
        body.message ||
          `スタブ: ${planKey} の Checkout セッション準備完了（キー未設定）`
      );
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
      setMessage(body.message || "カスタマーポータルはスタブです（キー未設定）");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "portal_failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <p className="mb-4 text-sm muted leading-relaxed">
        Botの契約は御社のまま。Staffpassは<strong className="text-[var(--text)] font-medium">就業規則と日報</strong>
        です。月額で境界を敷き、確定した仕事の分だけ従量。Managed は Care（伴走）込みです。
      </p>

      <p className="mb-4 text-xs faint leading-relaxed">
        表示価格はすべて{" "}
        <span className="chip text-[10px]">{PRICING_PROVISIONAL_NOTE_JA}</span>
        。Checkout 実課金は Stripe Dashboard の Price が正です。
      </p>

      {checkoutBanner ? (
        <p
          className={`mb-4 text-sm surface p-4 ${
            checkoutBanner.kind === "ok" ? "text-[var(--text)]" : "muted"
          }`}
        >
          {checkoutBanner.text}
        </p>
      ) : null}

      {(currentPlan || currentStatus) && (
        <div className="mb-4 text-xs faint">
          現在: プラン <span className="muted">{currentPlan || "—"}</span> · 状態{" "}
          <span className="muted">{currentStatus || "—"}</span>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        {PLANS.map((plan) => (
          <div
            key={plan.id}
            className={`surface p-5 ${
              plan.featured ? "ring-1 ring-[var(--text-faint)]" : ""
            }`}
          >
            <div className="text-xs faint">{plan.id}</div>
            <h2 className="mt-1 text-lg font-medium">{plan.name}</h2>
            <p className="mt-2 text-2xl font-medium tracking-tight">
              {formatYenJa(plan.displayYen)}
              <span className="text-sm font-normal muted"> / 月</span>
            </p>
            <p className="mt-1 text-[10px] faint">{PRICING_PROVISIONAL_NOTE_JA}</p>
            <p className="mt-2 text-xs faint">
              確定アクション枠{" "}
              <span className="muted">{plan.quota.toLocaleString("ja-JP")} / 月</span>{" "}
              <span className="chip text-[10px] ml-1">仮枠</span>
            </p>
            <p className="mt-1 text-xs muted">
              超過: {formatYenJa(plan.overageYen)} / 確定アクション
              <span className="faint">（従量・P0.5）</span>
            </p>
            {plan.onboardingYen != null ? (
              <p className="mt-1 text-xs muted">
                導入（初回一式）: {formatYenJa(plan.onboardingYen)}
                <span className="faint">（税別・仮決め）</span>
              </p>
            ) : null}
            {plan.onboardingNote ? (
              <p className="mt-1 text-xs faint">{plan.onboardingNote}</p>
            ) : null}
            {plan.bundleNote ? (
              <p className="mt-1 text-xs faint leading-relaxed">{plan.bundleNote}</p>
            ) : null}
            <ul className="mt-4 space-y-2 text-sm muted">
              {plan.points.map((p) => (
                <li key={p}>· {p}</li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-primary w-full mt-5 text-sm"
              disabled={busy === plan.id}
              onClick={() => void checkout(plan.id)}
            >
              {busy === plan.id ? "準備中…" : "Checkout へ"}
            </button>
          </div>
        ))}
      </div>

      <div className="mt-6 grid lg:grid-cols-2 gap-4">
        <div className="surface p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs faint">kickoff_pack</span>
            <span className="chip text-[10px]">任意</span>
            <span className="chip text-[10px]">{PRICING_PROVISIONAL_NOTE_JA}</span>
          </div>
          <h2 className="mt-1 text-lg font-medium">キックオフパック</h2>
          <p className="mt-2 text-2xl font-medium tracking-tight">
            {formatYenJa(KICKOFF_PACK_YEN)}
            <span className="text-sm font-normal muted"> 一式</span>
          </p>
          <p className="mt-2 text-xs muted leading-relaxed">{KICKOFF_PACK_NOTE_JA}</p>
          <p className="mt-1 text-xs faint leading-relaxed">{KICKOFF_GROK_BAND_JA}</p>
          <ul className="mt-4 space-y-2 text-sm muted">
            {KICKOFF_PACK_LINES.map((line) => (
              <li key={line.key} className="flex justify-between gap-3">
                <span>· {line.labelJa}</span>
                <span className="shrink-0 faint">{formatYenJa(line.yen)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs faint leading-relaxed">
            Checkout は Stripe Price（`STRIPE_PRICE_ID_KICKOFF_PACK`）設定後に有効化します。キー未設定のあいだは表示のみ（仮決め）。
          </p>
          <button
            type="button"
            className="btn btn-ghost w-full mt-4 text-sm"
            disabled={busy === "kickoff"}
            onClick={() => {
              setBusy("kickoff");
              setMessage(
                "キックオフパックは仮決め表示です。STRIPE_PRICE_ID_KICKOFF_PACK を Dashboard で作成・貼付後に Checkout 配線します（Business 初月は含みません）。"
              );
              setBusy(null);
            }}
          >
            仮決め・準備中
          </button>
        </div>

        <div className="surface p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs faint">subsidy_*</span>
            <span className="chip text-[10px]">準備中</span>
          </div>
          <h2 className="mt-1 text-lg font-medium">補助金関連パック</h2>
          <p className="mt-2 text-sm muted leading-relaxed">{SUBSIDY_COMING_SOON_JA}</p>
          <ul className="mt-4 space-y-2 text-sm muted">
            <li>· subsidy_2y_business — Business・2年想定</li>
            <li>· subsidy_2y_managed — Managed・2年想定</li>
            <li>· year3_extension — 3年目延長</li>
          </ul>
          <p className="mt-4 text-xs faint leading-relaxed">{SUBSIDY_COMPLIANCE_NOTE_JA}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-3 items-center">
        <button
          type="button"
          className="btn btn-ghost text-sm"
          disabled={busy === "portal"}
          onClick={() => void openPortal()}
        >
          {busy === "portal" ? "開いています…" : "カスタマーポータル"}
        </button>
        {!hasStripeCustomer ? (
          <span className="text-xs faint">
            ※ 初回は Checkout 後にポータルが使えます
          </span>
        ) : null}
      </div>

      <p className="mt-3 text-xs faint leading-relaxed">
        銀行振込は準備が整い次第、お支払い画面に表示されます。表示は
        {PRICING_PROVISIONAL_NOTE_JA}
        。Checkout 実額は Stripe Price ID（env）が正です。枠数は仮枠です。課金対象は
        Gateway 経由の確定アクション成功のみです。超過従量の Stripe Metered Price
        は P0.5（未配線）。
      </p>

      {message ? (
        <p className="mt-4 text-sm muted surface p-4">{message}</p>
      ) : null}
    </>
  );
}
