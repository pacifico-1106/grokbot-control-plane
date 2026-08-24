"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Soft fallback if any /app page still throws (e.g. org_id_required).
 * Avoids opaque "Application error" digest-only screen.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[/app error]", error?.message, error?.digest);
  }, [error]);

  const missingOrg =
    /org_id_required|org_not_found|org_create_failed/i.test(error?.message || "");

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-lg surface p-6 md:p-8">
        <p className="text-xs faint">エラー</p>
        <h1 className="mt-2 text-xl font-bold tracking-tight">
          ダッシュボードの読み込みに失敗しました
        </h1>
        <p className="mt-3 text-sm muted leading-relaxed">
          {missingOrg
            ? "ログインは成功していますが、組織データがありません。修復ページで組織を作成できます。"
            : "一時的なサーバーエラーの可能性があります。再試行するか、組織修復ページを開いてください。"}
        </p>
        {error?.digest ? (
          <p className="mt-2 text-xs faint">Digest: {error.digest}</p>
        ) : null}
        <div className="mt-6 flex flex-col sm:flex-row gap-2">
          <Link href="/onboarding?reason=provision" className="btn btn-primary flex-1 text-center">
            組織を修復
          </Link>
          <button type="button" className="btn btn-ghost flex-1" onClick={() => reset()}>
            再試行
          </button>
          <Link href="/api/auth/repair-org" className="btn btn-ghost flex-1 text-center">
            修復 URL
          </Link>
        </div>
      </div>
    </div>
  );
}
