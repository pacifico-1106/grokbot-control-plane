import Link from "next/link";

const NAV = [
  { href: "/app", label: "ダッシュボード" },
  { href: "/app/approvals", label: "承認キュー" },
  { href: "/app/audit", label: "監査ログ" },
  { href: "/app/settings", label: "連携設定" },
  { href: "/app/billing", label: "請求" },
];

export function AppShell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="min-h-screen flex bg-[var(--bg)] text-[var(--text)]">
      <aside
        className="hidden md:flex flex-col border-r border-[var(--border)] bg-[var(--bg-elevated)]"
        style={{ width: "var(--sidebar-w)" }}
      >
        <div className="px-5 py-5 border-b border-[var(--border-soft)]">
          <Link href="/" className="block">
            <div className="text-[13px] faint tracking-wide">Grok Bot</div>
            <div className="text-[15px] font-medium mt-0.5">AI社員 制御面</div>
          </Link>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-lg px-3 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-[var(--border-soft)] text-xs faint">
          Managed / BYO 両対応
        </div>
      </aside>
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 border-b border-[var(--border)] px-4 md:px-8 flex items-center justify-between bg-[var(--bg)]/80 backdrop-blur">
          <div>
            <h1 className="text-[15px] font-medium leading-tight">{title}</h1>
            {subtitle ? (
              <p className="text-xs muted mt-0.5">{subtitle}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <span className="chip chip-ok">トライアル</span>
            <span className="chip">demo@example.com</span>
          </div>
        </header>
        <main className="flex-1 px-4 md:px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
