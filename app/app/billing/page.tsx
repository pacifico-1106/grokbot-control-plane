import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { BillingClient } from "@/components/BillingClient";
import { getSessionContext } from "@/lib/auth/session";
import { entitlementsFromSubscription } from "@/lib/billing/entitlements";
import { getOrgStripeCustomerId, getSubscription } from "@/lib/data/subscriptions";
import { describeJpPaymentMethods } from "@/lib/stripe";
import { isStripeConfigured } from "@/lib/mode";

const STATUS_LABELS: Record<string, string> = {
  active: "契約中",
  trialing: "トライアル中",
  past_due: "お支払い確認中",
  canceled: "解約済み",
  unpaid: "未払い",
};

const PLAN_LABELS: Record<string, string> = {
  starter: "スターター",
  business: "ビジネス",
  managed: "Managed",
};

export default async function BillingPage() {
  const session = await getSessionContext();
  const orgId = session.orgId;
  const sub = await getSubscription(orgId);
  const entitlements = entitlementsFromSubscription(sub);
  const customerId = orgId ? await getOrgStripeCustomerId(orgId) : null;

  const statusChip =
    entitlements.status === "active" || entitlements.status === "trialing"
      ? "chip"
      : entitlements.blocked
        ? "chip chip-warn"
        : "chip";

  return (
    <AppShell title="請求">
      <section className="surface mb-4 overflow-hidden">
        <header className="border-b border-[var(--border)] px-4 py-3 sm:px-5">
          <h2 className="text-sm font-bold">現在の契約</h2>
        </header>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 p-4 text-sm sm:p-5">
          <span className={statusChip}>
            {STATUS_LABELS[entitlements.status] ?? entitlements.status}
          </span>
          <span className="font-semibold">
            {PLAN_LABELS[entitlements.plan] ?? entitlements.plan}
          </span>
          {sub?.trialEndsAt ? (
            <span className="text-xs faint">
              終了予定 {" "}
              {new Date(sub.trialEndsAt).toLocaleDateString("ja-JP", {
                timeZone: "Asia/Tokyo",
              })}{" "}
              JST
            </span>
          ) : null}
          {sub?.currentPeriodEnd ? (
            <span className="text-xs faint">
              次回更新 {" "}
              {new Date(sub.currentPeriodEnd).toLocaleDateString("ja-JP", {
                timeZone: "Asia/Tokyo",
              })}{" "}
              JST
            </span>
          ) : null}
          {entitlements.blocked && entitlements.blockReasonJa ? (
            <span className="text-xs text-[var(--warn,#c9a227)] w-full">
              {entitlements.blockReasonJa}
            </span>
          ) : null}
        </div>
      </section>

      <Suspense fallback={<p className="text-sm muted">読み込み中…</p>}>
        <BillingClient
          hasStripeCustomer={Boolean(customerId)}
          stripeConfigured={isStripeConfigured()}
        />
      </Suspense>

      <section className="surface mt-4 overflow-hidden">
        <header className="border-b border-[var(--border)] px-4 py-3 sm:px-5">
          <h2 className="text-sm font-bold">お支払い方法</h2>
        </header>
        <div className="p-4 sm:p-5">
          <p className="text-sm muted leading-relaxed">{describeJpPaymentMethods()}</p>
          {process.env.STRIPE_ENABLE_CUSTOMER_BALANCE !== "1" ? (
            <p className="mt-2 text-xs faint">銀行振込をご希望の場合はお問い合わせください</p>
          ) : null}
        </div>
      </section>
    </AppShell>
  );
}
