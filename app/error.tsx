"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Unexpected 500s on public/auth pages. Credential misses stay on /login.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[error]", error?.message, error?.digest);
  }, [error]);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <p className="text-xs faint">エラー</p>
        <h1 className="mt-2 text-xl font-bold tracking-tight">
          ページを表示できませんでした
        </h1>
        <p className="mt-3 text-sm muted leading-relaxed">
          一時的なサーバーエラーの可能性があります。再試行するか、ログイン画面に戻ってください。
        </p>
        {error?.digest ? (
          <p className="mt-2 text-xs faint">Digest: {error.digest}</p>
        ) : null}
        <div className="mt-6 flex flex-col sm:flex-row gap-2">
          <button type="button" className="btn btn-primary flex-1" onClick={() => reset()}>
            再試行
          </button>
          <Link href="/login" className="btn btn-ghost flex-1 text-center">
            ログイン
          </Link>
        </div>
      </div>
    </div>
  );
}
