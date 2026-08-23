import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { BillingClient } from "@/components/BillingClient";
import { getSessionContext } from "@/lib/auth/session";
import { entitlementsFromSubscription } from "@/lib/billing/entitlements";
import { getOrgStripeCustomerId, getSubscription } from "@/lib/data/subscriptions";
import { describeJpPaymentMethods, TRIAL_DAYS } from "@/lib/stripe";

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
    <AppShell
      title="請求"
      subtitle={`トライアル ${TRIAL_DAYS}日 · カード / 銀行振込`}
    >
      <div className="surface p-4 mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span className={statusChip}>{entitlements.status}</span>
        <span className="muted">プラン: {entitlements.plan}</span>
        {sub?.trialEndsAt ? (
          <span className="text-xs faint">
            トライアル終了予定:{" "}
            {new Date(sub.trialEndsAt).toLocaleDateString("ja-JP", {
              timeZone: "Asia/Tokyo",
            })}{" "}
            JST
          </span>
        ) : null}
        {sub?.currentPeriodEnd ? (
          <span className="text-xs faint">
            次回更新:{" "}
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

      <Suspense fallback={<p className="text-sm muted">読み込み中…</p>}>
        <BillingClient
          currentPlan={entitlements.plan}
          currentStatus={entitlements.status}
          hasStripeCustomer={Boolean(customerId)}
        />
      </Suspense>

      <section className="surface p-5 mt-4">
        <h2 className="text-sm font-medium">日本向け支払い方法</h2>
        <p className="mt-2 text-sm muted leading-relaxed">
          {describeJpPaymentMethods()}
        </p>
        <p className="mt-2 text-xs faint leading-relaxed">
          流れ: トライアル開始 → お支払い手続き → 契約状態の同期 → 終了前のメール通知。
          銀行振込は準備が整い次第、お支払い画面に表示されます。
        </p>
      </section>
    </AppShell>
  );
}
