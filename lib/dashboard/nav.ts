/** Dashboard shell nav (locked product policy). Japanese labels. */

export type DashboardNavItem = {
  href: string;
  label: string;
  icon: string;
  exact?: boolean;
};

/** Always-visible daily shell. Revoke is a row action, not a nav item. */
export const PRIMARY_NAV: DashboardNavItem[] = [
  { href: "/app", label: "変更ログ", icon: "≡", exact: true },
  { href: "/app/approvals", label: "承認", icon: "✓" },
  { href: "/app/audit", label: "閲覧", icon: "◉" },
];

/** Collapsed 「その他」. /app/employees/new is intentionally absent. */
export const OTHER_NAV: DashboardNavItem[] = [
  { href: "/app/employees", label: "AI社員一覧", icon: "◇" },
  { href: "/app/integrations", label: "連携", icon: "⌁" },
  { href: "/app/billing", label: "請求", icon: "¥" },
  { href: "/app/team", label: "チーム", icon: "◎" },
  { href: "/app/settings", label: "つながり", icon: "•" },
];

export const GUIDE_NAV: DashboardNavItem[] = [
  { href: "/app/getting-started", label: "はじめに", icon: "→" },
  { href: "/app/guides/instructions-design", label: "Instructions設計", icon: "Aa" },
  { href: "/app/guides/approval-loop", label: "承認ループ", icon: "↻" },
];

export const OTHER_SECTION_LABEL = "その他";
export const GUIDE_GROUP_LABEL = "ガイド";

export function navActive(pathname: string, item: { href: string; exact?: boolean }): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(item.href + "/");
}

export function otherSectionActive(pathname: string): boolean {
  return (
    OTHER_NAV.some((item) => navActive(pathname, item)) ||
    GUIDE_NAV.some((item) => navActive(pathname, item))
  );
}

export const ALWAYS_ON_HREFS = PRIMARY_NAV.map((item) => item.href);
export const COLLAPSED_HREFS = [...OTHER_NAV, ...GUIDE_NAV].map((item) => item.href);
