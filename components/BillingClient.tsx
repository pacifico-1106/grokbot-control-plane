"use client";

import { useState } from "react";
import type { CheckoutPlanKey } from "@/lib/stripe";

const PLANS: Array<{
  id: CheckoutPlanKey | "enterprise";
  name: string;
  price: string;
  points: string[];
  featured?: boolean;
}> = [
  {
    id: "starter",
    name: "Starter",
    price: "体験・少人数",
    points: ["社員証 1〜3", "基本監査", "メール通知"],
  },
  {
    id: "business",
    name: "Business",
    price: "本命 · SME",
    points: ["承認キュー", "監査タイムライン", "チーム（owner/admin）"],
    featured: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "要相談",
    points: ["SSO / SLA", "長期保管", "導入支援"],
  },
];

export function BillingClient() {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

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
      if (!res.ok) throw new Error(body.error || "checkout_failed");
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

  return (
    <>
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
            <ul className="mt-4 space-y-2 text-sm muted">
              {plan.points.map((p) => (
                <li key={p}>· {p}</li>
              ))}
            </ul>
            {plan.id === "enterprise" ? (
              <button type="button" className="btn btn-ghost w-full mt-5 text-sm" disabled>
                お問い合わせ
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary w-full mt-5 text-sm"
                disabled={busy === plan.id}
                onClick={() => void checkout(plan.id as CheckoutPlanKey)}
              >
                {busy === plan.id ? "準備中…" : "Checkout へ"}
              </button>
            )}
          </div>
        ))}
      </div>
      {message ? (
        <p className="mt-4 text-sm muted surface p-4">{message}</p>
      ) : null}
    </>
  );
}
