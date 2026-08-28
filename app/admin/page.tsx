import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { StatCard } from "@/components/StatCard";
import { getSuperAdminAccess } from "@/lib/admin/access";
import {
  getAdminOverview,
  type AdminOrganizationStatus,
} from "@/lib/admin/data";

const STATUS_LABELS: Record<AdminOrganizationStatus, string> = {
  active: "契約中",
  trialing: "トライアル",
  attention: "要確認",
  onboarding: "導入中",
  quiet: "未稼働",
};

const SUBSCRIPTION_LABELS: Record<string, string> = {
  active: "契約中",
  trialing: "トライアル",
  past_due: "支払確認中",
  canceled: "解約済み",
  incomplete: "申込未完了",
  unpaid: "未払い",
  none: "未契約",
};

function formatDate(value: string | null, includeTime = false): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(value));
}

export default async function SuperAdminDashboard({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const access = await getSuperAdminAccess();
  if (!access.allowed) {
    if (access.reason === "unauthenticated") redirect("/login?next=/admin&reason=session");
    notFound();
  }

  const [{ q = "", status = "all" }, overview] = await Promise.all([
    searchParams,
    getAdminOverview(access.actor),
  ]);
  const query = q.trim().toLowerCase();
  const organizations = overview.organizations.filter((org) => {
    const matchesQuery =
      !query ||
      [org.name, org.ownerEmail, org.ownerName, org.id, org.referralCode]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    const matchesStatus = status === "all" || org.status === status;
    return matchesQuery && matchesStatus;
  });

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">PLATFORM OPERATIONS</p>
          <h1 className="mt-2 text-2xl font-bold sm:text-3xl">事業者ダッシュボード</h1>
          <p className="mt-2 text-sm muted">申込・契約・利用状況を横断確認する運営者専用の読み取り画面です。</p>
        </div>
        <p className="text-xs faint">最終表示 {formatDate(new Date().toISOString(), true)} JST</p>
      </div>

      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
        <StatCard label="事業者" value={String(overview.totals.organizations)} hint={`直近30日 +${overview.totals.signupsLast30Days}`} />
        <StatCard label="契約中" value={String(overview.totals.activeSubscriptions)} hint="active" />
        <StatCard label="トライアル" value={String(overview.totals.trialingSubscriptions)} hint="trialing" />
        <StatCard label="30日内に稼働" value={String(overview.totals.activeOrganizationsLast30Days)} hint="監査ログ基準" />
        <StatCard label="要確認" value={String(overview.totals.attentionNeeded)} hint="支払・期限・接続" tone={overview.totals.attentionNeeded ? "warn" : "default"} />
        <StatCard label="AI社員" value={String(overview.totals.employees)} hint="全事業者合計" />
        <StatCard label="今月アクション" value={overview.totals.actionsThisMonth.toLocaleString("ja-JP")} hint="確定系カウンター" />
        <StatCard label="未稼働" value={String(overview.organizations.filter((org) => org.status === "quiet").length)} hint="7日超・30日活動なし" />
      </section>

      <section className="surface mt-6 overflow-hidden">
        <div className="border-b border-[var(--border)] p-4 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-base font-bold">事業者一覧</h2>
              <p className="mt-1 text-xs faint">申込は組織作成時点を基準に集計しています。表示 {organizations.length} / {overview.organizations.length} 件</p>
            </div>
            <form method="get" className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
              <label className="sr-only" htmlFor="admin-search">事業者を検索</label>
              <input id="admin-search" name="q" defaultValue={q} placeholder="会社名・メール・組織ID" className="min-h-11 w-full border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-[var(--accent-strong)] sm:w-72" />
              <label className="sr-only" htmlFor="admin-status">状態</label>
              <select id="admin-status" name="status" defaultValue={status} className="min-h-11 border border-[var(--border)] bg-[var(--bg)] px-3 text-sm">
                <option value="all">すべて</option>
                <option value="attention">要確認</option>
                <option value="trialing">トライアル</option>
                <option value="active">契約中</option>
                <option value="onboarding">導入中</option>
                <option value="quiet">未稼働</option>
              </select>
              <button type="submit" className="btn btn-primary px-4 text-sm">絞り込む</button>
            </form>
          </div>
        </div>

        <div className="table-scroll">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="bg-[var(--bg-soft)] text-xs muted">
              <tr>
                <th className="px-4 py-3 font-semibold">事業者 / 申込者</th>
                <th className="px-4 py-3 font-semibold">状態</th>
                <th className="px-4 py-3 text-right font-semibold">利用</th>
                <th className="px-4 py-3 font-semibold">接続</th>
                <th className="px-4 py-3 font-semibold">最終活動</th>
                <th className="px-4 py-3 font-semibold">申込日</th>
                <th className="px-4 py-3 font-semibold">サポート</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-soft)]">
              {organizations.map((org) => (
                <tr key={org.id} className="hover:bg-[var(--bg-soft)]/55">
                  <td className="px-4 py-4">
                    <Link href={`/admin/organizations/${org.id}`} className="font-semibold hover:underline">{org.name}</Link>
                    <div className="mt-1 max-w-72 truncate text-xs muted" title={org.ownerEmail || undefined}>{org.ownerEmail || "オーナー未登録"}</div>
                    <div className="mt-1 font-mono text-[10px] faint">{org.id}</div>
                  </td>
                  <td className="px-4 py-4">
                    <span className={`chip ${org.status === "attention" ? "chip-warn" : org.status === "active" ? "chip-ok" : ""}`}>{STATUS_LABELS[org.status]}</span>
                    <div className="mt-2 text-xs faint">{SUBSCRIPTION_LABELS[org.subscriptionStatus] || org.subscriptionStatus} · {org.planKey}</div>
                    {org.trialEndsAt ? <div className="mt-1 text-[11px] faint">期限 {formatDate(org.trialEndsAt)}</div> : null}
                  </td>
                  <td className="px-4 py-4 text-right tabular-nums">
                    <div>AI社員 {org.employeeCount}</div>
                    <div className="mt-1 text-xs muted">今月 {org.actionsThisMonth.toLocaleString("ja-JP")}</div>
                    {org.pendingApprovals ? <div className="mt-1 text-xs text-[var(--warn)]">承認待ち {org.pendingApprovals}</div> : null}
                  </td>
                  <td className="px-4 py-4">
                    <span className={org.gatewayStatus === "linked" ? "chip chip-ok" : org.gatewayStatus === "disconnected" ? "chip chip-warn" : "chip"}>{org.gatewayStatus}</span>
                    <div className="mt-1 text-[11px] faint">{org.integrationMode}</div>
                  </td>
                  <td className="px-4 py-4 text-xs">{formatDate(org.lastActivityAt, true)}</td>
                  <td className="px-4 py-4 text-xs">{formatDate(org.createdAt)}</td>
                  <td className="px-4 py-4">
                    <div className="flex gap-2">
                      <Link href={`/admin/organizations/${org.id}`} className="btn btn-ghost min-h-9 px-3 py-1 text-xs">詳細</Link>
                      {org.ownerEmail ? <a href={`mailto:${org.ownerEmail}`} className="btn btn-ghost min-h-9 px-3 py-1 text-xs">メール</a> : null}
                    </div>
                  </td>
                </tr>
              ))}
              {organizations.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-sm muted">条件に一致する事業者はありません。</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
