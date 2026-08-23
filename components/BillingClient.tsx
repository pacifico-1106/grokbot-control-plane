"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { CheckoutPlanKey } from "@/lib/stripe";
import { PLAN_CONFIRM_QUOTAS } from "@/lib/billing/plans";

const PLANS: Array<{
  id: CheckoutPlanKey;
  name: string;
  /** Placeholder — real yen amounts live in Stripe Dashboard only. */
  price: string;
  points: string[];
  featured?: boolean;
  /** 仮枠 monthly gated confirms */
  quota: number;
}> = [
  {
    id: "starter",
    name: "スターター",
    price: "{{STARTER_PRICE}} / 月（Dashboardで設定）",
    points: [
      "AI社員 少数・基本の就業規則",
      "基本監査（日報の入口）",
      "メール通知",
      "propose / draft 中心",
    ],
    quota: PLAN_CONFIRM_QUOTAS.starter,
  },
  {
    id: "business",
    name: "ビジネス",
    price: "{{BUSINESS_PRICE}} / 月（Dashboardで設定）",
    points: [
      "就業規則と日報（承認・監査）",
      "承認キュー・監査タイムライン",
      "チーム（職務・権限）",
      "確定アクションの従量メーター",
    ],
    featured: true,
    quota: PLAN_CONFIRM_QUOTAS.business,
  },
  {
    id: "managed",
    name: "Managed（Care）",
    price: "{{MANAGED_PRICE}} / 月（Dashboardで設定）",
    points: [
      "Business 全部＋専任伴走（Care）",
      "導入代行・週次ヘルス",
      "要再連携の一次対応",
      "確定枠は厚め（仮枠）",
    ],
    quota: PLAN_CONFIRM_QUOTAS.managed,
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
            <p className="mt-1 text-sm muted">{plan.price}</p>
            <p className="mt-2 text-xs faint">
              確定アクション枠{" "}
              <span className="muted">{plan.quota.toLocaleString("ja-JP")} / 月</span>{" "}
              <span className="chip text-[10px] ml-1">仮枠</span>
            </p>
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
        銀行振込は準備が整い次第、お支払い画面に表示されます。表示価格は契約プランの設定が正です。
        枠数は仮枠（事業確定前）です。課金対象は Gateway 経由の確定アクション成功のみです。
      </p>

      {message ? (
        <p className="mt-4 text-sm muted surface p-4">{message}</p>
      ) : null}
    </>
  );
}
