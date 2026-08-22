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
    body: "職務を日本語で説明 → Draft 確認 → 予算・承認の補足 → 社員証発行。秘密値は一度だけ表示されます。実際の発注・送信は Gateway 経由のみ（Botに直結ツールを載せない）。",
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

        <section className="surface p-5 space-y-2">
          <h2 className="text-sm font-medium">権限を守らせる（自動 / 手動）</h2>
          <p className="text-sm muted leading-relaxed">
            実際の発注・送信は Gateway 経由のみ。Botに直結ツールを載せない。
            社員証・予算・承認は Gateway が fail-closed で強制します。Managed ではツール面の削ぎ落としも当社側の運用です。
          </p>
          <p className="text-xs faint">
            実装・運用の詳細:{" "}
            <code className="font-mono">docs/enforcement-auto-vs-manual.md</code>
            {" · "}
            <code className="font-mono">docs/spend-delegation.md</code>
          </p>
          <Link
            href="/app/integrations"
            className="btn btn-ghost mt-2 text-xs px-3 py-1.5 inline-flex"
          >
            連携・Gateway を確認
          </Link>
        </section>
      </div>
    </AppShell>
  );
}
