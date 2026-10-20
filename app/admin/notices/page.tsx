import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { isOperatorNoticesEnabled } from "@/lib/feature-flags";
import { listOperatorNoticesWithStats } from "@/lib/operator-notices/admin";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const STATUS_JA: Record<string, string> = {
  draft: "下書き",
  published: "公開",
  withdrawn: "取り下げ",
};

const AUDIENCE_JA: Record<string, string> = {
  all: "全テナント",
  orgs: "テナント限定",
  employees: "社員限定",
};

export default async function AdminNoticesPage() {
  const access = await getSuperAdminAccess();
  if (!access.allowed) {
    if (access.reason === "unauthenticated") redirect("/login?next=/admin/notices&reason=session");
    notFound();
  }
  if (!isOperatorNoticesEnabled()) {
    return (
      <>
        <p className="eyebrow">OPERATOR NOTICES</p>
        <h1 className="mt-2 text-2xl font-bold">運営からのお知らせ</h1>
        <p className="mt-3 text-sm muted">OPERATOR_NOTICES_ENABLED が OFF です。フラグを入れたあとで作成・公開できます。既定は OFF のままです。</p>
      </>
    );
  }

  const listed = await listOperatorNoticesWithStats({
    userId: access.actor.userId,
    email: access.actor.email,
  });
  const rows = listed.ok ? listed.rows : [];

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">OPERATOR NOTICES</p>
          <h1 className="mt-2 text-2xl font-bold">運営からのお知らせ</h1>
          <p className="mt-2 text-sm muted">公開できるのはこの画面だけです。AI 社員は MCP で読むだけで、公開はできません。</p>
        </div>
        <Link href="/admin/notices/new" className="btn btn-primary px-4 text-sm">新規作成</Link>
      </div>

      <section className="surface mt-6 overflow-hidden">
        <div className="table-scroll">
          <table className="w-full min-w-[1080px] text-left text-sm">
            <thead className="bg-[var(--bg-soft)] text-xs muted">
              <tr>
                <th className="px-4 py-3 font-semibold">#</th>
                <th className="px-4 py-3 font-semibold">題名</th>
                <th className="px-4 py-3 font-semibold">状態</th>
                <th className="px-4 py-3 font-semibold">重要度</th>
                <th className="px-4 py-3 font-semibold">宛先</th>
                <th className="px-4 py-3 font-semibold">公開</th>
                <th className="px-4 py-3 text-right font-semibold">既読 / 反映 / 未反映</th>
                <th className="px-4 py-3 font-semibold">wake失敗</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-soft)]">
              {rows.map(({ notice, stats }) => (
                <tr key={notice.id} className="hover:bg-[var(--bg-soft)]/55">
                  <td className="px-4 py-3 tabular-nums">{notice.seq}</td>
                  <td className="px-4 py-3">
                    <Link href={`/admin/notices/${notice.id}`} className="font-semibold hover:underline">{notice.title}</Link>
                    <div className="mt-1 font-mono text-[10px] faint">{notice.id}</div>
                  </td>
                  <td className="px-4 py-3">{STATUS_JA[notice.status] ?? notice.status}</td>
                  <td className="px-4 py-3">{notice.severity}</td>
                  <td className="px-4 py-3">{AUDIENCE_JA[notice.audienceScope] ?? notice.audienceScope}</td>
                  <td className="px-4 py-3 text-xs">{formatDate(notice.publishedAt)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-xs">
                    {stats.total === 0 ? "—" : `${stats.total - stats.delivered} / ${stats.applied} / ${stats.pendingApply}`}
                    <div className="faint">n={stats.total}</div>
                  </td>
                  <td className="px-4 py-3">{stats.wakeFailed || "—"}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm muted">お知らせはまだありません。</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
