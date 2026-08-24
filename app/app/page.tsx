import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DashboardActivity } from "@/components/DashboardActivity";
import { StatCard } from "@/components/StatCard";
import { getCurrentOrgId } from "@/lib/auth/session";
import { entitlementsFromSubscription } from "@/lib/billing/entitlements";
import {
  getConfirmUsageSummary,
  QUOTA_PROVISIONAL_NOTE_JA,
} from "@/lib/billing/meter";
import {
  countNeedsReauth,
  getGatewayStatusForOrg,
  getOrgMeta,
  getSubscription,
  listApprovals,
  listAuditEvents,
  listEmployees,
} from "@/lib/data";
import { isDemoMode } from "@/lib/mode";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const orgId = await getCurrentOrgId();
  const org = await getOrgMeta(orgId);
  const employees = (await listEmployees(orgId)) ?? [];
  const approvals = (await listApprovals(orgId)) ?? [];
  const pending = approvals.filter(
    (a) => a.status === "pending"
  ).length;
  const gateway = await getGatewayStatusForOrg(orgId);
  const reauthCount = await countNeedsReauth(org.id);
  const sub = await getSubscription(orgId);
  const entitlements = entitlementsFromSubscription(sub);
  const confirmUsage = await getConfirmUsageSummary(orgId, entitlements.plan);
  const demoMode = isDemoMode();
  const auditEvents = demoMode
    ? []
    : (await listAuditEvents(orgId, 500)).map((e) => ({
        employeeId: e.employeeId,
        action: e.action,
        createdAt: e.createdAt,
        metadata: e.metadata ?? null,
      }));

  return (
    <AppShell
      title="ダッシュボード"
      subtitle={`${org.name} · トライアル中`}
    >
      {reauthCount > 0 ? (
        <div
          className="mb-4 rounded-lg border px-3 sm:px-4 py-3 text-sm flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-3 min-w-0"
          style={{
            borderColor: "color-mix(in oklab, var(--warn) 45%, var(--border))",
            background: "color-mix(in oklab, var(--warn) 10%, transparent)",
          }}
          role="alert"
        >
          <div className="min-w-0 break-words">
            <strong style={{ color: "var(--warn)" }}>再接続が必要</strong>
            <span className="muted sm:ml-2 text-xs block sm:inline mt-1 sm:mt-0">
              接続が切れた AI社員がいます（{reauthCount} 件）。記録は残したまま、つなぎ直しが必要です。
            </span>
          </div>
          <Link href="/app/integrations" className="btn btn-ghost text-sm w-full sm:w-auto shrink-0">
            連携を確認
          </Link>
        </div>
      ) : null}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard
          label="AI社員"
          value={String(employees.length)}
          hint="稼働中"
        />
        <StatCard label="承認待ち" value={String(pending)} hint="要対応" />
        <StatCard
          label="今月の確定アクション"
          value={`${confirmUsage.used} / ${confirmUsage.quota}`}
          hint={`プラン枠（${confirmUsage.plan}）· ${QUOTA_PROVISIONAL_NOTE_JA}`}
        />
        <StatCard
          label="再接続が必要"
          value={String(reauthCount)}
          hint="つなぎ直し待ち"
        />
        <StatCard
          label="導入モード"
          value={org.integrationMode === "managed" ? "当社で用意" : "持ち込み"}
          hint={gateway === "linked" ? "Staffpass（制御）接続中" : gateway === "pending" ? "連携の手続き中" : "未連携"}
        />
      </div>

      <section className="surface p-4 mt-4 text-sm leading-relaxed">
        <h2 className="text-sm font-medium">確定アクションとは</h2>
        <p className="mt-2 muted">
          人が確認したうえで進めた送信・日程確定・発注などです。下書きや提案、承認ボタンのクリックだけでは増えません。
          残枠の目安は {confirmUsage.remaining} 回です（{QUOTA_PROVISIONAL_NOTE_JA}）。
        </p>
        <p className="mt-2 text-xs faint">
          計測は制御面 Gateway を通った確定系のみです。Bot のすべての操作を課金対象にしていません。
        </p>
      </section>

      <DashboardActivity
        mode={demoMode ? "demo" : "production"}
        auditEvents={auditEvents}
        confirmUsed={confirmUsage.used}
        confirmQuota={confirmUsage.quota}
        planKey={entitlements.plan}
        employees={employees.map((e) => ({
          id: e?.id ?? "unknown",
          displayName: e?.displayName ?? "未設定",
          roleLabel: e?.roleLabel ?? "",
        }))}
      />

      {employees.length === 0 ? (
        <section className="surface p-6 mt-6 text-center">
          <p className="text-sm font-medium">まずは AI社員を雇いましょう</p>
          <p className="mt-2 text-sm muted">
            職務を日本語で説明するだけで、権限の案と社員証が用意できます。
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
                  className="flex items-center justify-between rounded-lg border border-[var(--border-soft)] px-3 py-2.5 gap-2"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/app/employees/${e.id}`}
                      className="text-sm hover:underline"
                    >
                      {e.displayName}
                    </Link>
                    <div className="text-xs muted">{e.roleLabel}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link
                      href={`/app/employees/${e.id}/actions`}
                      className="text-[11px] muted underline underline-offset-2"
                    >
                      ログ
                    </Link>
                    <span className="chip chip-ok">{e.status}</span>
                  </div>
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
                {approvals
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
            <div className="mt-4 flex flex-col sm:flex-row flex-wrap gap-2">
              <Link href="/app/getting-started" className="btn btn-ghost text-sm w-full sm:w-auto">
                はじめに
              </Link>
              <Link href="/app/integrations" className="btn btn-ghost text-sm w-full sm:w-auto">
                連携
              </Link>
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}
