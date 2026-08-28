"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useAppSession } from "@/components/AppSessionProvider";
import { LegalLinks } from "@/components/LegalLinks";

const NAV = [
  { href: "/app", label: "ダッシュボード", icon: "◫", exact: true },
  { href: "/app/employees", label: "AI社員", icon: "◇" },
  { href: "/app/approvals", label: "承認", icon: "✓" },
  { href: "/app/audit", label: "監査", icon: "≡" },
  { href: "/app/integrations", label: "連携", icon: "⌁" },
  { href: "/app/billing", label: "請求", icon: "¥" },
  { href: "/app/team", label: "チーム", icon: "◎" },
  { href: "/app/settings", label: "つながり", icon: "•" },
];

const GUIDE_NAV = [
  { href: "/app/getting-started", label: "はじめに", icon: "→" },
  { href: "/app/guides/instructions-design", label: "Instructions設計", icon: "Aa" },
  { href: "/app/guides/approval-loop", label: "承認ループ", icon: "↻" },
];

function navActive(pathname: string, item: { href: string; exact?: boolean }) {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(item.href + "/");
}

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
  const [menuOpen, setMenuOpen] = useState(false);
  const panelId = useId();
  const session = useAppSession();
  const memberEmail =
    session.email ||
    (session.demo ? "owner@example.com" : null);
  const memberLabel = memberEmail || "—";
  const memberTitle =
    session.displayName && session.displayName !== memberEmail
      ? `${session.displayName} · ${memberLabel}`
      : session.displayName || memberLabel;

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  return (
    <div className="min-h-screen flex bg-[var(--bg)] text-[var(--text)] overflow-x-hidden">
      <aside
        className="hidden md:flex flex-col border-r border-[var(--border)] bg-[var(--bg-elevated)] shrink-0"
        style={{ width: "var(--sidebar-w)" }}
      >
        <div className="px-5 py-5 border-b border-[var(--border-soft)]">
          <BrandMark size="sm" href="/" />
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV.map((item) => {
            const active = navActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-xl px-3 py-2.5 text-sm min-h-[44px] flex items-center gap-3 ${
                  active
                    ? "bg-[var(--bg-soft)] text-[var(--text)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
                }`}
              >
                <span className="w-5 text-center text-[var(--text-faint)]" aria-hidden>{item.icon}</span>{item.label}
              </Link>
            );
          })}
          {session.superAdmin ? (
            <Link
              href="/admin"
              className="rounded-xl px-3 py-2.5 text-sm min-h-[44px] flex items-center gap-3 text-[var(--accent-strong)] hover:bg-[var(--bg-soft)]"
            >
              <span className="w-5 text-center" aria-hidden>⌘</span>運営管理
            </Link>
          ) : null}
          <div className="pt-5 pb-2 px-3 text-[10px] font-semibold tracking-[0.14em] text-[var(--text-faint)]">
            運用ガイド
          </div>
          {GUIDE_NAV.map((item) => {
            const active = navActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-xl px-3 py-2.5 text-sm min-h-[44px] flex items-center gap-3 ${active ? "bg-[var(--bg-soft)] text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"}`}
              >
                <span className="w-5 text-center text-[11px] font-mono text-[var(--accent-strong)]" aria-hidden>{item.icon}</span>{item.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-5 py-4 border-t border-[var(--border-soft)] text-[10px] faint">
          <LegalLinks className="gap-x-2 gap-y-1 leading-relaxed" />
          <p className="mt-3 tracking-wide">STAFFPASS CONTROL CENTER</p>
        </div>
      </aside>

      {/* Mobile drawer */}
      <div
        className={`fixed inset-0 z-40 md:hidden ${menuOpen ? "" : "pointer-events-none"}`}
        aria-hidden={!menuOpen}
      >
        <button
          type="button"
          className={`absolute inset-0 bg-black/55 transition-opacity ${
            menuOpen ? "opacity-100" : "opacity-0"
          }`}
          aria-label="メニューを閉じる"
          onClick={() => setMenuOpen(false)}
        />
        <aside
          id={panelId}
          role="dialog"
          aria-modal="true"
          aria-label="ナビゲーション"
          className={`absolute inset-y-0 left-0 w-[min(288px,86vw)] max-w-full flex flex-col border-r border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl transition-transform duration-200 ease-out pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${
            menuOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="px-4 py-4 border-b border-[var(--border-soft)] flex items-center justify-between gap-2">
            <BrandMark size="sm" href="/" />
            <button
              type="button"
              className="btn btn-ghost text-sm min-h-[44px] min-w-[44px] px-3"
              onClick={() => setMenuOpen(false)}
              aria-label="閉じる"
            >
              ✕
            </button>
          </div>
          <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto">
            {NAV.map((item) => {
              const active = navActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-xl px-3 py-3 text-sm min-h-[44px] flex items-center gap-3 break-words ${
                    active
                      ? "bg-[var(--bg-soft)] text-[var(--text)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
                  }`}
                  onClick={() => setMenuOpen(false)}
                >
                  <span className="w-5 text-center text-[var(--text-faint)]" aria-hidden>{item.icon}</span>{item.label}
                </Link>
              );
            })}
            {session.superAdmin ? (
              <Link
                href="/admin"
                className="rounded-xl px-3 py-3 text-sm min-h-[44px] flex items-center gap-3 text-[var(--accent-strong)] hover:bg-[var(--bg-soft)]"
                onClick={() => setMenuOpen(false)}
              >
                <span className="w-5 text-center" aria-hidden>⌘</span>運営管理
              </Link>
            ) : null}
            <div className="pt-5 pb-2 px-3 text-[10px] font-semibold tracking-[0.14em] text-[var(--text-faint)]">
              運用ガイド
            </div>
            {GUIDE_NAV.map((item) => {
              const active = navActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-xl px-3 py-3 text-sm min-h-[44px] flex items-center gap-3 ${active ? "bg-[var(--bg-soft)] text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"}`}
                  onClick={() => setMenuOpen(false)}
                >
                  <span className="w-5 text-center text-[11px] font-mono text-[var(--accent-strong)]" aria-hidden>{item.icon}</span>{item.label}
                </Link>
              );
            })}
          </nav>
          <div className="px-4 py-4 border-t border-[var(--border-soft)] text-[10px] faint">
            <LegalLinks className="gap-x-2 gap-y-1 leading-relaxed" />
            <p className="mt-3 tracking-wide">STAFFPASS CONTROL CENTER</p>
          </div>
        </aside>
      </div>

      <div className="flex-1 min-w-0 flex flex-col max-w-full">
        <header className="min-h-14 border-b border-[var(--border)] px-3 sm:px-4 md:px-8 py-2 flex items-center justify-between gap-2 bg-[var(--bg)]/80 backdrop-blur sticky top-0 z-30 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              type="button"
              className="btn btn-ghost shrink-0 min-h-[44px] min-w-[44px] px-2.5 md:!hidden"
              aria-expanded={menuOpen}
              aria-controls={panelId}
              aria-label={menuOpen ? "メニューを閉じる" : "メニューを開く"}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span className="flex flex-col gap-1.5 w-5" aria-hidden>
                <span className="block h-0.5 w-full rounded bg-[var(--text)]" />
                <span className="block h-0.5 w-full rounded bg-[var(--text)]" />
                <span className="block h-0.5 w-full rounded bg-[var(--text)]" />
              </span>
            </button>
            <div className="min-w-0">
              <h1 className="text-[15px] font-semibold leading-tight whitespace-nowrap">
                {title}
              </h1>
              {subtitle ? (
                <p className="text-[11px] muted leading-tight mt-0.5 truncate">{subtitle}</p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <span className="chip chip-ok shrink-0 !hidden lg:!inline-flex">
              トライアル
            </span>
            <span
              className="chip !hidden sm:!inline-flex max-w-[12rem] truncate text-xs sm:text-sm"
              title={memberTitle}
            >
              {memberLabel}
            </span>
            <form action="/api/auth/logout" method="post" className="shrink-0">
              <button
                type="submit"
                className="btn btn-ghost text-xs sm:text-sm min-h-[44px] px-2.5 sm:px-3"
                aria-label="ログアウト"
                title={memberTitle !== "—" ? memberTitle : "ログアウト"}
              >
                ログアウト
              </button>
            </form>
          </div>
        </header>
        <main className="flex-1 px-3 sm:px-4 md:px-8 py-5 md:py-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] min-w-0 max-w-full overflow-x-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
