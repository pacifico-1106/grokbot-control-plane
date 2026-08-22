import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DashboardActivity } from "@/components/DashboardActivity";
import { StatCard } from "@/components/StatCard";
import {
  DEMO_ORG,
  getGatewayStatus,
  getRuntimeApprovals,
  getRuntimeEmployees,
} from "@/lib/demo-data";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const employees = getRuntimeEmployees();
  const pending = getRuntimeApprovals().filter((a) => a.status === "pending")
    .length;
  const gateway = getGatewayStatus();

  return (
    <AppShell
      title="ダッシュボード"
      subtitle={`${DEMO_ORG.name} · トライアル中`}
    >
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="AI社員"
          value={String(employees.length)}
          hint="稼働中"
        />
        <StatCard label="承認待ち" value={String(pending)} hint="要対応" />
        <StatCard
          label="導入モード"
          value={DEMO_ORG.integrationMode === "managed" ? "Managed" : "BYO"}
          hint={`連携: ${gateway}`}
        />
        <StatCard label="トライアル残" value="14日" hint="Stripe 契約前" />
      </div>

      <DashboardActivity
        employees={(employees ?? []).map((e) => ({
          id: e.id,
          displayName: e.displayName ?? "未設定",
          roleLabel: e.roleLabel ?? "",
        }))}
      />

      {employees.length === 0 ? (
        <section className="surface p-6 mt-6 text-center">
          <p className="text-sm font-medium">まずは AI社員を雇いましょう</p>
          <p className="mt-2 text-sm muted">
            職務を日本語で説明するだけで、権限 Draft と社員証が用意できます。
          </p>
          <Link
            href="/app/employees/new"
            className="btn btn-primary mt-4 text-sm inline-flex"
          >
            AI社員を雇う
          </Link>
        </section>
      ) : (
        <div className="mt-6 grid lg:grid-cols-2 gap-4">
          <section className="surface p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">AI社員</h2>
              <Link href="/app/employees" className="text-xs muted underline">
                すべて
              </Link>
            </div>
            <ul className="mt-4 space-y-3">
              {employees.slice(0, 4).map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between rounded-lg border border-[var(--border-soft)] px-3 py-2.5"
                >
                  <div>
                    <Link
                      href={`/app/employees/${e.id}`}
                      className="text-sm hover:underline"
                    >
                      {e.displayName}
                    </Link>
                    <div className="text-xs muted">{e.roleLabel}</div>
                  </div>
                  <span className="chip chip-ok">{e.status}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/app/employees/new"
              className="btn btn-ghost mt-4 text-xs px-3 py-1.5 inline-flex"
            >
              もう一人雇う
            </Link>
          </section>

          <section className="surface p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">次のアクション</h2>
              <Link href="/app/approvals" className="text-xs muted underline">
                承認へ
              </Link>
            </div>
            {pending === 0 ? (
              <p className="mt-4 text-sm muted">要対応はありません。</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {getRuntimeApprovals()
                  .filter((a) => a.status === "pending")
                  .slice(0, 3)
                  .map((a) => (
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
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/app/getting-started" className="btn btn-ghost text-xs px-3 py-1.5">
                はじめに
              </Link>
              <Link href="/app/integrations" className="btn btn-ghost text-xs px-3 py-1.5">
                連携
              </Link>
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}
