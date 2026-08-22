import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { StatCard } from "@/components/StatCard";
import { DEMO_APPROVALS, DEMO_EMPLOYEES, DEMO_ORG } from "@/lib/demo-data";

export default function DashboardPage() {
  const pending = DEMO_APPROVALS.filter((a) => a.status === "pending").length;

  return (
    <AppShell
      title="ダッシュボード"
      subtitle={`${DEMO_ORG.name} · トライアル中`}
    >
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="AI社員" value={String(DEMO_EMPLOYEES.length)} hint="稼働中" />
        <StatCard label="承認待ち" value={String(pending)} hint="要対応" />
        <StatCard label="導入モード" value="Managed" hint="設定で BYO に切替可" />
        <StatCard label="トライアル残" value="14日" hint="Stripe 契約前" />
      </div>

      <div className="mt-6 grid lg:grid-cols-2 gap-4">
        <section className="surface p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">AI社員</h2>
            <span className="text-xs faint">社員証付き</span>
          </div>
          <ul className="mt-4 space-y-3">
            {DEMO_EMPLOYEES.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between rounded-lg border border-[var(--border-soft)] px-3 py-2.5"
              >
                <div>
                  <div className="text-sm">{e.displayName}</div>
                  <div className="text-xs muted">{e.roleLabel}</div>
                </div>
                <span className="chip chip-ok">{e.status}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="surface p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">次のアクション</h2>
            <Link href="/app/approvals" className="text-xs muted underline">
              すべて見る
            </Link>
          </div>
          <ul className="mt-4 space-y-3">
            {DEMO_APPROVALS.slice(0, 2).map((a) => (
              <li
                key={a.id}
                className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="chip chip-warn">{a.risk}</span>
                  <span className="text-xs faint">{a.purpose}</span>
                </div>
                <p className="mt-2 text-sm leading-snug">{a.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
