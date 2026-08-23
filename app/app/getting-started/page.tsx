import Link from "next/link";
import { AppShell } from "@/components/AppShell";

const STEPS = [
  {
    title: "トライアル開始",
    body: "会社名とメールで Staffpass（制御）を開き、14日間のトライアルに入ります。",
    href: "/signup",
    label: "サインアップ",
  },
  {
    title: "導入モードを選ぶ",
    body: "「当社で用意」か「持ち込み」かを選び、Grok Bot とのつながりを「連携済み」にします。",
    href: "/app/integrations",
    label: "連携へ",
  },
  {
    title: "最初の AI社員を雇う",
    body: "職務を日本語で説明 → 権限の案を確認 → 予算・承認の補足 → 社員証発行。接続用の鍵は一度だけ表示されます。実際の発注・送信は、承認・監査を通す仕組み（Staffpass）経由だけです。",
    href: "/app/employees/new",
    label: "雇う",
  },
  {
    title: "承認キューを見る",
    body: "危ない操作は「要対応」に並びます。承認されるまで実行しません。",
    href: "/app/approvals",
    label: "承認へ",
  },
  {
    title: "監査タイムライン",
    body: "誰が・何の目的で・何をしたかを、あとから説明できる形で残します。",
    href: "/app/audit",
    label: "監査へ",
  },
  {
    title: "請求（トライアル後）",
    body: "カード決済、または銀行振込の案内へ進めます。",
    href: "/app/billing",
    label: "請求へ",
  },
];

export default function GettingStartedPage() {
  return (
    <AppShell
      title="はじめに"
      subtitle="中小企業向けの始め方 · 当社で用意 / 持ち込み"
    >
      <div className="space-y-3">
        {STEPS.map((step, i) => (
          <section key={step.title} className="surface p-5">
            <p className="text-xs faint font-mono">
              STEP {String(i + 1).padStart(2, "0")}
            </p>
            <h2 className="mt-2 text-sm font-medium">{step.title}</h2>
            <p className="mt-2 text-sm muted leading-relaxed">{step.body}</p>
            <Link href={step.href} className="btn btn-ghost mt-4 text-sm w-full sm:w-auto inline-flex">
              {step.label}
            </Link>
          </section>
        ))}

        <section className="surface p-5 space-y-2">
          <h2 className="text-sm font-medium">Instructionsの組み立て方</h2>
          <p className="text-sm muted leading-relaxed">
            Base（固定ルール）／Role（職務の型）／Skills &amp; Routines（変わりやすい手順）に分けて書く。全部を Instructions に詰め込まない。
          </p>
          <Link
            href="/app/guides/instructions-design"
            className="btn btn-ghost mt-2 text-sm w-full sm:w-auto inline-flex"
          >
            ガイドを読む
          </Link>
        </section>

        <section className="surface p-5 space-y-2">
          <h2 className="text-sm font-medium">権限を守らせる（自動 / 手動）</h2>
          <p className="text-sm muted leading-relaxed">
            実際の発注・送信は、当社の承認ルート経由だけです。AI社員に直結の「勝手に送る道具」は載せません。
            社員証・予算・承認は Staffpass（制御）が守り、承認されるまで実行しません。当社で用意する場合は、道具の整理も当社が引き受けます。
          </p>
          <Link
            href="/app/integrations"
            className="btn btn-ghost mt-2 text-sm w-full sm:w-auto inline-flex"
          >
            連携を確認
          </Link>
        </section>
      </div>
    </AppShell>
  );
}
