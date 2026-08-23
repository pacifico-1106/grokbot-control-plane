"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/app", label: "ダッシュボード", exact: true },
  { href: "/app/employees", label: "AI社員" },
  { href: "/app/approvals", label: "承認" },
  { href: "/app/audit", label: "監査" },
  { href: "/app/getting-started", label: "はじめに" },
  { href: "/app/integrations", label: "連携" },
  { href: "/app/billing", label: "請求" },
  { href: "/app/team", label: "チーム" },
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
  const pathname = usePathname();

  return (
    <div className="min-h-screen flex bg-[var(--bg)] text-[var(--text)]">
      <aside
        className="hidden md:flex flex-col border-r border-[var(--border)] bg-[var(--bg-elevated)]"
        style={{ width: "var(--sidebar-w)" }}
      >
        <div className="px-5 py-5 border-b border-[var(--border-soft)]">
          <Link href="/" className="block">
            <div className="text-[13px] faint tracking-wide">Grok Bot</div>
            <div className="text-[15px] font-medium mt-0.5">AI社員 Staffpass</div>
          </Link>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-lg px-3 py-2 text-sm ${
                  active
                    ? "bg-[var(--bg-soft)] text-[var(--text)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-5 py-4 border-t border-[var(--border-soft)] text-xs faint">
          当社で用意 / 持ち込み 両対応
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
            <span className="chip">owner@example.com</span>
          </div>
        </header>
        <div className="md:hidden border-b border-[var(--border)] px-3 py-2 flex gap-1 overflow-x-auto">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="chip whitespace-nowrap">
              {item.label}
            </Link>
          ))}
        </div>
        <main className="flex-1 px-4 md:px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
