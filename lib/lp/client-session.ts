/**
 * Browser-side helpers for the LP guest session.
 *
 * The guest cookie is HttpOnly and never touched here. The CSRF token is a
 * readable cookie (double-submit) that must be echoed in the x-csrf-token
 * header on every state-changing call.
 */

export const LP_CSRF_COOKIE = "lp_csrf";
export const LP_CSRF_HEADER = "x-csrf-token";

/** Version string recorded with the guest's privacy consent. Bump when /legal/privacy changes. */
export const LP_PRIVACY_VERSION = "2026-09";

export function readCsrfCookie(cookieString: string): string | null {
  for (const part of cookieString.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === LP_CSRF_COOKIE) {
      const value = rest.join("=");
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/** Only same-site relative paths under the LP are followed from server-provided card data. */
export function isSafeLpPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.startsWith("/lp/ai-employee/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !/[\u0000-\u001f]/.test(path)
  );
}

export interface ProposalCard {
  type: "proposal_card";
  sku: string;
  displayName: string;
  setupAmountExTax: number | null;
  monthlyAmountExTax: number | null;
  checkoutUrl: string;
  note?: string;
}

export interface HandoffPreviewCard {
  type: "handoff_preview";
  reason: string;
  summaryDraft: string;
  note?: string;
}

export type ChatCard = ProposalCard | HandoffPreviewCard;

/** Narrow untrusted card JSON from the chat API to the two shapes the UI knows. */
export function parseChatCard(raw: unknown): ChatCard | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "proposal_card") {
    if (typeof r.sku !== "string" || typeof r.displayName !== "string") return null;
    if (!isSafeLpPath(r.checkoutUrl)) return null;
    return {
      type: "proposal_card",
      sku: r.sku,
      displayName: r.displayName,
      setupAmountExTax: typeof r.setupAmountExTax === "number" ? r.setupAmountExTax : null,
      monthlyAmountExTax: typeof r.monthlyAmountExTax === "number" ? r.monthlyAmountExTax : null,
      checkoutUrl: r.checkoutUrl,
      note: typeof r.note === "string" ? r.note : undefined,
    };
  }
  if (r.type === "handoff_preview") {
    if (typeof r.reason !== "string" || typeof r.summaryDraft !== "string") return null;
    return {
      type: "handoff_preview",
      reason: r.reason.slice(0, 500),
      summaryDraft: r.summaryDraft.slice(0, 2000),
      note: typeof r.note === "string" ? r.note : undefined,
    };
  }
  return null;
}
