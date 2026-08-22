import { AppShell } from "@/components/AppShell";
import { describeJpPaymentMethods, TRIAL_DAYS } from "@/lib/stripe";

export default function BillingPage() {
  return (
    <AppShell
      title="請求"
      subtitle={`トライアル ${TRIAL_DAYS}日 · Stripe Subscriptions`}
    >
      <div className="grid lg:grid-cols-3 gap-4">
        {[
          {
            id: "starter",
            name: "Starter",
            price: "低〜中",
            points: ["社員証 1〜3", "基本監査", "体験・社内布石"],
          },
          {
            id: "business",
            name: "Business",
            price: "本命",
            points: ["承認キュー", "監査エクスポート", "チーム管理"],
            featured: true,
          },
          {
            id: "enterprise",
            name: "Enterprise",
            price: "要相談",
            points: ["SSO / SLA", "長期保管", "導入支援"],
          },
        ].map((plan) => (
          <div
            key={plan.id}
            className={`surface p-5 ${plan.featured ? "ring-1 ring-[var(--text-faint)]" : ""}`}
          >
            <div className="text-xs faint">{plan.id}</div>
            <h2 className="mt-1 text-lg font-medium">{plan.name}</h2>
            <p className="mt-1 text-sm muted">{plan.price}</p>
            <ul className="mt-4 space-y-2 text-sm muted">
              {plan.points.map((p) => (
                <li key={p}>· {p}</li>
              ))}
            </ul>
            <button type="button" className="btn btn-primary w-full mt-5 text-sm">
              Checkout（スタブ）
            </button>
          </div>
        ))}
      </div>

      <section className="surface p-5 mt-4">
        <h2 className="text-sm font-medium">日本向け支払い方法</h2>
        <p className="mt-2 text-sm muted leading-relaxed">
          {describeJpPaymentMethods()}
        </p>
        <p className="mt-2 text-xs faint leading-relaxed">
          Stripe Subscriptions + トライアル。請求・領収・トライアル終了通知は Resend 経由のトランザクションメールで送ります。
        </p>
      </section>
    </AppShell>
  );
}
