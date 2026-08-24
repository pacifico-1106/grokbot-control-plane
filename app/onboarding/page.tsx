import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { getSessionContext } from "@/lib/auth/session";
import { isDemoMode } from "@/lib/mode";

export const dynamic = "force-dynamic";

/**
 * Soft recovery UI when Auth user exists but org/org_members could not be created
 * (typically: schema.sql not applied yet, then signup created Auth only).
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; detail?: string }>;
}) {
  const sp = await searchParams;
  const session = await getSessionContext();
  const demo = isDemoMode();
  const reason = sp.reason || "missing_org";
  const detail = sp.detail || "";

  const title =
    reason === "schema"
      ? "データベース準備が必要です"
      : "組織のセットアップを完了してください";

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-lg surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <p className="mt-5 text-xs faint">オンボーディング / 修復</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">{title}</h1>

        {session.email ? (
          <p className="mt-3 text-sm muted">
            ログイン中: <span className="text-[var(--text)]">{session.email}</span>
            {session.orgId ? "（組織は既にあります）" : "（組織未作成）"}
          </p>
        ) : (
          <p className="mt-3 text-sm muted">
            セッションがありません。先にログインしてください。
          </p>
        )}

        {reason === "schema" ? (
          <div className="mt-4 text-sm leading-relaxed space-y-2 muted">
            <p>
              Auth ユーザーは作成済みですが、Supabase に{" "}
              <code className="text-xs">orgs</code> /{" "}
              <code className="text-xs">org_members</code>{" "}
              テーブルが無い（または未適用）ため組織を作れませんでした。
            </p>
            <ol className="list-decimal list-inside space-y-1 text-xs faint">
              <li>Supabase SQL Editor で <code>supabase/schema.sql</code> を実行</li>
              <li>既存 DB なら migrations を docs/production-cutover.md の順で適用</li>
              <li>下の「組織を修復」を押すか、もう一度 /app を開く</li>
            </ol>
          </div>
        ) : (
          <p className="mt-4 text-sm muted leading-relaxed">
            初回ログイン時に組織を自動作成します。スキーマ適用後に修復ボタンを押すか、
            <Link href="/app" className="underline mx-1">
              ダッシュボード
            </Link>
            を再度開いてください。
          </p>
        )}

        {detail ? (
          <p className="mt-3 text-xs faint break-all">詳細: {detail}</p>
        ) : null}

        {demo ? (
          <p className="mt-4 text-sm muted">デモモードです。ダッシュボードへ進めます。</p>
        ) : null}

        <div className="mt-6 flex flex-col sm:flex-row gap-2">
          {session.userId ? (
            <form action="/api/auth/repair-org" method="post" className="flex-1">
              <button type="submit" className="btn btn-primary w-full">
                組織を修復してダッシュボードへ
              </button>
            </form>
          ) : (
            <Link href="/login?next=/app" className="btn btn-primary flex-1 text-center">
              ログイン
            </Link>
          )}
          <Link href="/app" className="btn btn-ghost flex-1 text-center">
            /app を再試行
          </Link>
        </div>

        <p className="mt-4 text-xs faint">
          サインアップ途中で失敗した場合も、同じメールでログイン → この修復で完了できます。
          新規登録のやり直しは不要です（Auth ユーザーが残っているため）。
        </p>
      </div>
    </div>
  );
}
