import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { StatCard } from "@/components/StatCard";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { getAdminOrganizationDetail } from "@/lib/admin/data";

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
export default async function AdminOrganizationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await getSuperAdminAccess();
  if (!access.allowed) {
    if (access.reason === "unauthenticated") redirect("/login?next=/admin");
    notFound();
  }

  const { id } = await params;
  const detail = await getAdminOrganizationDetail(access.actor, id);
  if (!detail) notFound();
  const org = detail.organization;

  return (
    <>
      <Link href="/admin" className="text-sm muted hover:underline">← 事業者一覧</Link>
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold sm:text-3xl">{org.name}</h1>
            <span className={org.status === "attention" ? "chip chip-warn" : org.status === "active" ? "chip chip-ok" : "chip"}>{org.status}</span>
          </div>
          <p className="mt-2 break-all font-mono text-xs faint">{org.id}</p>
        </div>
        {org.ownerEmail ? <a href={`mailto:${org.ownerEmail}`} className="btn btn-primary text-sm">申込者にメール</a> : null}
      </div>

      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        <StatCard label="契約" value={org.subscriptionStatus} hint={org.planKey} tone={org.status === "attention" ? "warn" : "default"} />
        <StatCard label="AI社員" value={String(org.employeeCount)} hint={`メンバー ${org.memberCount}人`} />
        <StatCard label="今月アクション" value={org.actionsThisMonth.toLocaleString("ja-JP")} hint="確定系" />
        <StatCard label="承認待ち" value={String(org.pendingApprovals)} hint="要対応" tone={org.pendingApprovals ? "warn" : "default"} />
        <StatCard label="Gateway" value={org.gatewayStatus} hint={org.integrationMode} />
        <StatCard label="最終活動" value={formatDate(org.lastActivityAt)} hint={org.lastActivityAt ? formatDate(org.lastActivityAt, true) : "記録なし"} />
      </section>

      <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-4">
          <section className="surface overflow-hidden">
            <header className="border-b border-[var(--border)] px-4 py-3"><h2 className="text-sm font-bold">事業者情報</h2></header>
            <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-3 p-4 text-sm">
              <dt className="muted">申込者</dt><dd className="break-all">{org.ownerName || "—"} {org.ownerEmail ? <span className="block text-xs faint">{org.ownerEmail}</span> : null}</dd>
              <dt className="muted">申込日</dt><dd>{formatDate(org.createdAt, true)} JST</dd>
              <dt className="muted">トライアル期限</dt><dd>{formatDate(org.trialEndsAt)}</dd>
              <dt className="muted">紹介コード</dt><dd>{org.referralCode || "—"}</dd>
              <dt className="muted">導入モード</dt><dd>{org.integrationMode}</dd>
            </dl>
          </section>

          <section className="surface overflow-hidden">
            <header className="border-b border-[var(--border)] px-4 py-3"><h2 className="text-sm font-bold">メンバー</h2></header>
            <ul className="divide-y divide-[var(--border-soft)]">
              {detail.members.map((member) => (
                <li key={member.id} className="p-4">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold">{member.displayName || member.email}</p><p className="mt-1 break-all text-xs muted">{member.email}</p></div><span className="chip shrink-0">{member.role}</span></div>
                  <p className="mt-2 text-[11px] faint">{member.status} · {formatDate(member.createdAt)}</p>
                </li>
              ))}
              {!detail.members.length ? <li className="p-4 text-sm muted">メンバーはいません。</li> : null}
            </ul>
          </section>

          <section className="surface overflow-hidden">
            <header className="border-b border-[var(--border)] px-4 py-3"><h2 className="text-sm font-bold">AI社員</h2></header>
            <ul className="divide-y divide-[var(--border-soft)]">
              {detail.employees.map((employee) => (
                <li key={employee.id} className="flex items-center justify-between gap-3 p-4"><div className="min-w-0"><p className="truncate text-sm font-semibold">{employee.displayName}</p><p className="mt-1 text-xs muted">{employee.roleLabel}</p></div><span className={employee.status === "active" ? "chip chip-ok" : "chip"}>{employee.status}</span></li>
              ))}
              {!detail.employees.length ? <li className="p-4 text-sm muted">まだAI社員はいません。</li> : null}
            </ul>
          </section>
        </div>

        <section className="surface h-fit overflow-hidden">
          <header className="border-b border-[var(--border)] px-4 py-3"><h2 className="text-sm font-bold">直近の監査ログ</h2><p className="mt-1 text-xs faint">サポート時の状況確認用・最新100件</p></header>
          <ol className="divide-y divide-[var(--border-soft)]">
            {detail.recentEvents.map((event) => (
              <li key={event.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs text-[var(--accent-strong)]">{event.action}</span><time className="text-[11px] faint">{formatDate(event.createdAt, true)}</time></div>
                <p className="mt-2 text-sm leading-relaxed">{event.summary}</p>
                {event.actorEmail ? <p className="mt-2 text-xs muted">担当: {event.actorEmail}</p> : null}
              </li>
            ))}
            {!detail.recentEvents.length ? <li className="p-8 text-center text-sm muted">監査ログはまだありません。</li> : null}
          </ol>
        </section>
      </div>
    </>
  );
}
