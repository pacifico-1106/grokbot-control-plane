import { AppShell } from "@/components/AppShell";
import { BillingClient } from "@/components/BillingClient";
import { DEMO_SUBSCRIPTION } from "@/lib/demo-data";
import { describeJpPaymentMethods, TRIAL_DAYS } from "@/lib/stripe";

export default function BillingPage() {
  return (
    <AppShell
      title="請求"
      subtitle={`トライアル ${TRIAL_DAYS}日 · Stripe Subscriptions`}
    >
      <div className="surface p-4 mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span className="chip chip-warn">{DEMO_SUBSCRIPTION.status}</span>
        <span className="muted">プラン: {DEMO_SUBSCRIPTION.planKey}</span>
        {DEMO_SUBSCRIPTION.trialEndsAt ? (
          <span className="text-xs faint">
            トライアル終了予定:{" "}
            {new Date(DEMO_SUBSCRIPTION.trialEndsAt).toLocaleDateString("ja-JP", {
              timeZone: "Asia/Tokyo",
            })}{" "}
            JST
          </span>
        ) : null}
      </div>

      <BillingClient />

      <section className="surface p-5 mt-4">
        <h2 className="text-sm font-medium">日本向け支払い方法</h2>
        <p className="mt-2 text-sm muted leading-relaxed">
          {describeJpPaymentMethods()}
        </p>
        <p className="mt-2 text-xs faint leading-relaxed">
          フロー: トライアル開始 → Checkout（subscription + trial_period_days）→
          webhook で subscriptions 同期 → trial_will_end で Resend 通知。
          銀行振込は Stripe customer_balance / 請求書フローを Dashboard 側で有効化してから
          payment_method_types に追加してください。
        </p>
      </section>
    </AppShell>
  );
}
