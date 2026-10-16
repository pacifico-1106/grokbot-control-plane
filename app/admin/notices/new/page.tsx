import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NoticeEditor } from "@/components/admin/notices/NoticeEditor";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { isOperatorNoticesEnabled } from "@/lib/feature-flags";
import { listNoticeTargetPicker } from "@/lib/operator-notices/admin";

export default async function NewOperatorNoticePage() {
  const access = await getSuperAdminAccess();
  if (!access.allowed) {
    if (access.reason === "unauthenticated") redirect("/login?next=/admin/notices/new&reason=session");
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
  const picker = await listNoticeTargetPicker();
  if (!picker.ok) {
    return (
      <>
        <Link href="/admin/notices" className="text-sm muted hover:underline">← お知らせ一覧</Link>
        <p className="mt-4 text-sm text-[var(--warn)]">宛先候補を読めませんでした。</p>
      </>
    );
  }
  return (
    <>
      <Link href="/admin/notices" className="text-sm muted hover:underline">← お知らせ一覧</Link>
      <h1 className="mt-4 text-2xl font-bold">お知らせを作成</h1>
      <p className="mt-2 text-sm muted">保存は下書きです。公開は確認チェックと直近ログインのあと、この画面からだけ行います。</p>
      <div className="mt-6">
        <NoticeEditor picker={picker.picker} />
      </div>
    </>
  );
}
