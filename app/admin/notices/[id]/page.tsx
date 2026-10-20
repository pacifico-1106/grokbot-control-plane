import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NoticeEditor } from "@/components/admin/notices/NoticeEditor";
import { NoticeStatusTable } from "@/components/admin/notices/NoticeStatusTable";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { isOperatorNoticesEnabled } from "@/lib/feature-flags";
import {
  getOperatorNoticeBundle,
  listNoticeTargetPicker,
  listOperatorNoticeReceipts,
} from "@/lib/operator-notices/admin";

export default async function OperatorNoticeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await getSuperAdminAccess();
  if (!access.allowed) {
    if (access.reason === "unauthenticated") redirect("/login?next=/admin/notices&reason=session");
    notFound();
  }
  if (!isOperatorNoticesEnabled()) {
    return (
      <>
        <Link href="/admin/notices" className="text-sm muted hover:underline">← お知らせ一覧</Link>
        <p className="mt-4 text-sm muted">OPERATOR_NOTICES_ENABLED が OFF です。</p>
      </>
    );
  }
  const { id } = await params;
  const actor = { userId: access.actor.userId, email: access.actor.email };
  const [bundle, picker, receipts] = await Promise.all([
    getOperatorNoticeBundle(actor, id),
    listNoticeTargetPicker(),
    listOperatorNoticeReceipts(actor, id),
  ]);
  if (!bundle.ok) notFound();
  if (!picker.ok || !receipts.ok) {
    return (
      <>
        <Link href="/admin/notices" className="text-sm muted hover:underline">← お知らせ一覧</Link>
        <p className="mt-4 text-sm text-[var(--warn)]">お知らせを読めませんでした。</p>
      </>
    );
  }
  return (
    <>
      <Link href="/admin/notices" className="text-sm muted hover:underline">← お知らせ一覧</Link>
      <h1 className="mt-4 text-2xl font-bold">お知らせ #{bundle.notice.seq}</h1>
      <p className="mt-1 font-mono text-xs faint">{bundle.notice.id}</p>
      <div className="mt-6">
        <NoticeEditor
          notice={bundle.notice}
          targets={bundle.targets.map((t) => ({ orgId: t.orgId, employeeId: t.employeeId }))}
          picker={picker.picker}
          receiptsCsvHref={`/api/admin/notices/${bundle.notice.id}?format=csv`}
        />
      </div>
      <section className="surface mt-6 overflow-hidden">
        <div className="border-b border-[var(--border)] p-4 sm:p-5">
          <h2 className="text-base font-bold">受領の状況</h2>
          <p className="mt-1 text-xs faint">公開から 3 日たっても未反映の行を色付けします。CSV には本文を入れません。</p>
        </div>
        <NoticeStatusTable receipts={receipts.receipts} />
      </section>
    </>
  );
}
