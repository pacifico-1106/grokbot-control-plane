import Link from "next/link";
import { AppShell } from "@/components/AppShell";

const STEPS = [
  {
    title: "トライアル開始",
    body: "会社名とメールで制御面を開き、14日間のトライアルに入ります。",
    href: "/signup",
    label: "サインアップ",
  },
  {
    title: "導入モードを選ぶ",
    body: "Managed（こちらで Grok Bot を用意）か BYO（持ち込み）を選び、連携ステータスを linked にします。",
    href: "/app/integrations",
    label: "連携へ",
  },
  {
    title: "最初の AI社員を雇う",
    body: "職務を日本語で説明 → Draft 確認 → 社員証を発行。秘密値は一度だけ表示されます。",
    href: "/app/employees/new",
    label: "雇う",
  },
  {
    title: "承認キューを見る",
    body: "危険操作は要対応に並びます。承認するまで実行されません（fail-closed）。",
    href: "/app/approvals",
    label: "承認へ",
  },
  {
    title: "監査タイムライン",
    body: "誰が・何目的で・何をしたかを情シスが説明できる形で残します。",
    href: "/app/audit",
    label: "監査へ",
  },
  {
    title: "請求（トライアル後）",
    body: "Stripe Checkout でカード、または銀行振込（customer_balance）の導線へ。",
    href: "/app/billing",
    label: "請求へ",
  },
];

export default function GettingStartedPage() {
  return (
    <AppShell
      title="はじめに"
      subtitle="中小企業向けオンボーディング · Managed / BYO"
    >
      <div className="space-y-3">
        {STEPS.map((step, i) => (
          <section key={step.title} className="surface p-5">
            <p className="text-xs faint font-mono">
              STEP {String(i + 1).padStart(2, "0")}
            </p>
            <h2 className="mt-2 text-sm font-medium">{step.title}</h2>
            <p className="mt-2 text-sm muted leading-relaxed">{step.body}</p>
            <Link href={step.href} className="btn btn-ghost mt-4 text-xs px-3 py-1.5 inline-flex">
              {step.label}
            </Link>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
