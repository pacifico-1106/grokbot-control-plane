/**
 * 法務ページごとの「最終改定日」。
 *
 * 「制定・施行日」は全ページ共通の `LEGAL_EFFECTIVE_DATE`（lib/legal.ts）を使い、
 * 最終改定日はページ本文を変更した PR が main に入った日（日本時間）をここで
 * ページごとに管理する。本文を変更したら、そのページの日付だけを更新すること。
 *
 * 根拠（git log --first-parent origin/main -- app/legal/<page>/page.tsx）:
 * - commercialTransactions: PR #199（b1534ca, 2026-10-03 02:26 JST マージ）
 * - terms:                  PR #199（b1534ca, 2026-10-03 02:26 JST マージ）
 * - privacy:                PR #201（5c441ec, 2026-10-03 02:26 JST マージ）
 */
export const LEGAL_LAST_REVISED = {
  commercialTransactions: "2026年10月3日",
  terms: "2026年10月3日",
  privacy: "2026年10月3日",
} as const;

export type LegalPageKey = keyof typeof LEGAL_LAST_REVISED;
