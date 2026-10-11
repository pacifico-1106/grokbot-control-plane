import { isLpLeadPageDbEnabled } from "@/lib/feature-flags";
import { normalizeLpPage, parseLpRef, type LpPage } from "@/lib/lp/lp-page";

/**
 * lp_page / lp_ref columns, re-validated here (defence in depth). Empty object while
 * LP_LEAD_PAGE_DB_ENABLED is OFF so inserts never name a column the DB may not have yet.
 */
export function leadPageColumns(lpPage: unknown, lpRef: unknown): { lp_page?: LpPage; lp_ref?: string | null } {
  if (!isLpLeadPageDbEnabled()) return {};
  const page = normalizeLpPage(lpPage);
  return { lp_page: page, lp_ref: page === "ai-employee-corp" ? parseLpRef(lpRef) : null };
}
