import Link from "next/link";

const STEPS = [
  {
    n: "1",
    title: "Gateway が needs_approval",
    body: "confirm / send / order などで Staffpass がチケットを作り、approvalId・statusToken・pollUrl・summary を返す（HTTP 402）。",
  },
  {
    n: "2",
    title: "Bot は停止して poll",
    body: "作業を止め、署名付き status URL を GET。pending のあいだは確定しない。メールは副次通知のみ。",
  },
  {
    n: "3",
    title: "人間が承認画面で決定",
    body: "「承認」で許可、「却下」で中止。Resend 通知・任意の approvalNotifyEmail / callbackUrl は best-effort。",
  },
  {
    n: "4",
    title: "approved なら再 invoke",
    body: "同じ jobId / purpose / tool に approvalId を付けて Gateway 再実行。rejected ならジョブ中止。",
  },
];

const HONEST = [
  "Partner API webhook は未実装。来るまで poll が必須。",
  "メール本文をクロールして承認判定してはならない。",
  "DEMO でも本番でも同じ契約（偽の Partner 戻りは作らない）。",
];

export type ApprovalLoopContentProps = {
  showAppCtas?: boolean;
};

export function ApprovalLoopContent({
  showAppCtas = true,
}: ApprovalLoopContentProps) {
  return (
    <article className="mx-auto max-w-2xl space-y-4 min-w-0">
      <section className="surface p-5 space-y-3">
        <h2 className="text-sm font-medium">正本は署名付き status poll</h2>
        <p className="text-sm muted leading-relaxed">
          Staffpass ↔ Grok の承認ループは、Bot が{" "}
          <code className="text-xs">GET /api/approvals/status?id=&amp;token=</code>{" "}
          で結果を待つ形が一次経路です。Partner webhook が実装されるまで、これが必須です。
        </p>
        <ul className="space-y-2">
          {HONEST.map((line) => (
            <li key={line} className="text-xs muted leading-relaxed flex gap-2">
              <span className="chip chip-warn shrink-0 text-[10px]">正直</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="surface p-5 space-y-4">
        <h2 className="text-sm font-medium">4 ステップ</h2>
        <ol className="space-y-3">
          {STEPS.map((s) => (
            <li key={s.n} className="flex gap-3 min-w-0">
              <span className="chip shrink-0">{s.n}</span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{s.title}</p>
                <p className="mt-1 text-xs muted leading-relaxed">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="surface p-5 space-y-3">
        <h2 className="text-sm font-medium">DEMO での確認</h2>
        <ol className="list-decimal pl-5 space-y-2 text-sm muted leading-relaxed">
          <li>
            <Link href="/app/approvals" className="underline underline-offset-2">
              承認
            </Link>{" "}
            でチケットのタイトル・要約・tool を確認
          </li>
          <li>「デモ用 poll URL をコピー」→ 別タブで pending</li>
          <li>承認ボタン → 同じ URL で approved</li>
          <li>雇う画面の発行後に Instructions / Routine をコピー</li>
        </ol>
      </section>

      <section className="surface p-5 space-y-2">
        <h2 className="text-sm font-medium">関連</h2>
        <ul className="text-sm space-y-2">
          <li>
            <Link
              href="/guides/instructions-design"
              className="underline underline-offset-2"
            >
              Instructionsの組み立て方
            </Link>
          </li>
          <li>
            <a
              href="https://github.com/pacifico-1106/grokbot-control-plane/blob/main/docs/guides/approval-loop-runbook.md"
              className="underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
            >
              詳細ランブック（docs）
            </a>
          </li>
        </ul>
      </section>

      {showAppCtas ? (
        <section className="flex flex-col sm:flex-row flex-wrap gap-2">
          <Link href="/app/approvals" className="btn btn-primary text-sm min-h-[44px]">
            承認画面へ
          </Link>
          <Link
            href="/app/employees/new"
            className="btn btn-ghost text-sm min-h-[44px]"
          >
            AI社員を雇う
          </Link>
        </section>
      ) : (
        <section className="flex flex-col sm:flex-row flex-wrap gap-2">
          <Link href="/signup" className="btn btn-primary text-sm min-h-[44px]">
            トライアル
          </Link>
          <Link href="/login" className="btn btn-ghost text-sm min-h-[44px]">
            ログイン
          </Link>
        </section>
      )}
    </article>
  );
}
