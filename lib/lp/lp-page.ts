/**
 * Which landing page a lead came from (LP pattern A / B), plus the optional
 * referrer (`?ref=`) that pattern B is handed out with.
 *
 * Page: chosen ONLY from the fixed allowlist below. Anything a browser sends goes
 * through parseLpPage / normalizeLpPage first; an unknown or tampered value becomes
 * the original page and is never stored, echoed or used to build a URL.
 *
 * Ref: ^[A-Za-z0-9_-]{1,32}$ only. Invalid values are dropped (nothing recorded).
 * It is carried in an HttpOnly cookie set by middleware (see lp-ref-middleware.ts),
 * re-validated on every read, only honoured for pattern B, and never rendered on a page.
 * It is independent of the AIC- partner code (lib/auth/signup-guard.ts).
 *
 * Shared by server routes and client pages (no server-only imports here).
 */
export const LP_PAGES = ["ai-employee", "ai-employee-corp"] as const;
export type LpPage = (typeof LP_PAGES)[number];

/** Safe default: the original page. */
export const DEFAULT_LP_PAGE: LpPage = "ai-employee";

/** Query parameter that carries the page across /lp/ai-employee/{consult,checkout,thank-you,handoff}. */
export const LP_PAGE_PARAM = "from";

const HOME_PATH: Record<LpPage, string> = {
  "ai-employee": "/lp/ai-employee",
  "ai-employee-corp": "/lp/ai-employee-corp",
};

const LABEL: Record<LpPage, string> = {
  "ai-employee": "AI社員 導入パック",
  "ai-employee-corp": "Staffpass（AIエージェントの社員証）パターンB",
};

/** Exact match against the allowlist; anything else (case, whitespace, paths, non-strings) → null. */
export function parseLpPage(raw: unknown): LpPage | null {
  if (typeof raw !== "string") return null;
  for (const page of LP_PAGES) {
    if (raw === page) return page;
  }
  return null;
}

/** Allowlisted page, or the original page for anything unknown. */
export function normalizeLpPage(raw: unknown): LpPage {
  return parseLpPage(raw) ?? DEFAULT_LP_PAGE;
}

export function lpPageHomePath(page: LpPage): string {
  return HOME_PATH[page];
}

/**
 * Add `from=<page>` to a fixed same-site path for pattern B. The original page
 * adds nothing, so its links and Stripe URLs stay byte-identical.
 */
export function withLpPageParam(path: string, page: LpPage): string {
  if (page === DEFAULT_LP_PAGE) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${LP_PAGE_PARAM}=${page}`;
}

/** Human-readable label for notification emails: "/lp/ai-employee-corp（…）". */
export function lpPageLabel(page: LpPage): string {
  return `${HOME_PATH[page]}（${LABEL[page]}）`;
}

/** "流入ページ: …" line for plain-text notices; null when the stored value is missing or not allowlisted. */
export function lpPageNoticeLine(raw: unknown): string | null {
  const page = parseLpPage(raw);
  return page ? `流入ページ: ${lpPageLabel(page)}` : null;
}

// ---------------------------------------------------------------------------
// ?ref= (pattern B referrer)
// ---------------------------------------------------------------------------

export const LP_REF_PARAM = "ref";
export const LP_REF_COOKIE = "lp_ref";
export const LP_REF_MAX_LENGTH = 32;
/** 30 days: long enough for "look now, consult next week". */
export const LP_REF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const LP_REF_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Valid ref string or null. No trimming, no case folding, no decoding: exact match or dropped. */
export function parseLpRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return LP_REF_PATTERN.test(raw) ? raw : null;
}

/** Read and re-validate the lp_ref cookie from a raw Cookie header. */
export function readLpRefCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== LP_REF_COOKIE) continue;
    return parseLpRef(part.slice(eq + 1).trim());
  }
  return null;
}

/** The ref to record for a lead: only for pattern B, only from the validated cookie. */
export function resolveLpRef(page: LpPage, cookieHeader: string | null | undefined): string | null {
  if (page !== "ai-employee-corp") return null;
  return readLpRefCookie(cookieHeader);
}

/** "紹介元(ref): …" line for notices; null when missing or invalid. */
export function lpRefNoticeLine(raw: unknown): string | null {
  const ref = parseLpRef(raw);
  return ref ? `紹介元(ref): ${ref}` : null;
}
