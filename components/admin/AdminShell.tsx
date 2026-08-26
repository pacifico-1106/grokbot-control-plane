import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

export function AdminShell({
  children,
  email,
}: {
  children: React.ReactNode;
  email: string;
}) {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]/90 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1500px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <BrandMark size="sm" href="/admin" />
            <span className="chip shrink-0 border-[color-mix(in_oklab,var(--accent-strong)_45%,var(--border))] text-[var(--accent-strong)]">
              SUPER ADMIN
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden max-w-56 truncate text-xs muted sm:block" title={email}>
              {email}
            </span>
            <Link href="/app" className="btn btn-ghost px-3 text-xs">
              事業者画面
            </Link>
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="btn btn-ghost px-3 text-xs">
                ログアウト
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {children}
      </main>
    </div>
  );
}
