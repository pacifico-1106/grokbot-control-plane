import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { ChangeLog } from "@/components/ChangeLog";
import { SetupKickoff } from "@/components/SetupKickoff";
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
  getOrgAdminAgent,
  getOrgMeta,
  getSubscription,
  listApprovals,
  listAuditEvents,
  listEmployees,
} from "@/lib/data";
import { isDemoMode } from "@/lib/mode";
import { buildConcentration } from "@/lib/employees/concentration";
import { orgNeedsSetup } from "@/lib/dashboard/setup-state";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const orgId = await getCurrentOrgId();
  const org = await getOrgMeta(orgId);
  const employees = (await listEmployees(orgId)) ?? [];
  const concentration = buildConcentration(employees);
  const mostConcentrated = concentration.employees.find((row) => row.share === concentration.maxShare);
  const approvals = (await listApprovals(orgId)) ?? [];
  const pending = approvals.filter((a) => a.status === "pending").length;
  const gateway = await getGatewayStatusForOrg(orgId);
  const reauthCount = await countNeedsReauth(org.id);
  const sub = await getSubscription(orgId);
  const entitlements = entitlementsFromSubscription(sub);
  const confirmUsage = await getConfirmUsageSummary(orgId, entitlements.plan);
  const demoMode = isDemoMode();
  const auditEvents = (await listAuditEvents(orgId, 200)).map((e) => ({
    id: e.id,
    employeeId: e.employeeId,
    action: e.action,
    summary: e.summary,
    createdAt: e.createdAt,
  }));
  const adminAgent = await getOrgAdminAgent(orgId);
  const adminConnected = adminAgent?.status === "linked" && Boolean(adminAgent.grokBotAgentId);
  const confirmedEmployeeCount = employees.filter((e) => e.status === "active").length;
  const needsSetup = orgNeedsSetup({
    adminMcpConnected: adminConnected,
    confirmedEmployeeCount,
  });
  const names = Object.fromEntries(employees.map((e) => [e.id, e.displayName]));
  void demoMode;

  return (
    <AppShell
      title="変更ログ"
      subtitle={`${org.name} · トライアル中`}
    >
      {needsSetup ? (
        <SetupKickoff
          adminConnected={adminConnected}
          grokBotAgentId={adminAgent?.grokBotAgentId ?? null}
          opsDocLocation={adminAgent?.opsDocLocation ?? null}
          confirmedEmployeeCount={confirmedEmployeeCount}
        />
      ) : (
        <>
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

          <ChangeLog events={auditEvents} names={names} />

          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mt-6">
            <StatCard label="AI社員" value={String(employees.length)} hint="稼働中" />
            <StatCard label="承認待ち" value={String(pending)} hint="要対応" />
            <StatCard
              label="今月の確定アクション"
              value={`${confirmUsage.used} / ${confirmUsage.quota}`}
              hint={`プラン枠（${confirmUsage.plan}）· ${QUOTA_PROVISIONAL_NOTE_JA}`}
            />
            <StatCard label="再接続が必要" value={String(reauthCount)} hint="つなぎ直し待ち" />
            <StatCard
              label="権限集中度"
              value={`${Math.round(concentration.maxShare * 100)}%`}
              hint={mostConcentrated ? `${mostConcentrated.displayName}${concentration.flagged.includes(mostConcentrated.employeeId) ? " · 要分離" : ""}` : "高リスク権限なし"}
              tone={mostConcentrated && concentration.flagged.includes(mostConcentrated.employeeId) ? "warn" : "default"}
            />
            <StatCard
              label="導入モード"
              value={org.integrationMode === "managed" ? "当社で用意" : "持ち込み"}
              hint={gateway === "linked" ? "Staffpass（制御）接続中" : gateway === "pending" ? "連携の手続き中" : "未連携"}
            />
          </div>

          <details className="surface px-4 py-3 mt-4 text-sm leading-relaxed">
            <summary className="text-sm font-medium cursor-pointer">確定アクションの計測について</summary>
            <p className="mt-3 muted">
              人が確認したうえで進めた送信・日程確定・発注などです。下書きや提案、承認ボタンのクリックだけでは増えません。
              残枠の目安は {confirmUsage.remaining} 回です（{QUOTA_PROVISIONAL_NOTE_JA}）。
            </p>
            <p className="mt-2 text-xs faint">
              計測は制御面 Gateway を通った確定系のみです。変更ログ（雇用・権限・相手台帳）とは別です。
            </p>
          </details>

          <section className="surface p-5 mt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">次のアクション</h2>
              <Link href="/app/approvals" className="text-xs muted underline">承認へ</Link>
            </div>
            {pending === 0 ? (
              <p className="mt-4 text-sm muted">要対応はありません。</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {approvals.filter((a) => a.status === "pending").slice(0, 3).map((a) => (
                  <li key={a.id} className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="chip chip-warn">{a.risk}</span>
                      <span className="text-xs faint">{a.purpose}</span>
                    </div>
                    <p className="mt-2 text-sm leading-snug">{a.summary}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}
