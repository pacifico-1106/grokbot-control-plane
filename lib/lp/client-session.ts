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
export const LP_PRIVACY_VERSION = "2026-10";

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

/** Shown by the UI as the first assistant bubble; the model is told not to repeat it. */
export const LP_CHAT_GREETING =
  "こんにちは、StaffpassのAI相談窓口です。日報・議事録の下書き、問い合わせへの一次返信、予定調整など、AI社員に任せられる仕事やプラン選びについて、お気軽にご相談ください。";

/** Max transcript entries sent with a chat turn (the server caps again). */
export const LP_CHAT_HISTORY_LIMIT = 12;

/** Transcript sent with /api/chat/turn: user/assistant text only, newest last. */
export function buildTurnHistory(
  messages: ReadonlyArray<{ role: string; text: string }>
): Array<{ role: "user" | "assistant"; text: string }> {
  return messages
    .filter((m): m is { role: "user" | "assistant"; text: string } =>
      (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim() !== ""
    )
    .slice(-LP_CHAT_HISTORY_LIMIT)
    .map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }));
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

/** Normal contact path (consult form) when the human handoff flow is OFF. URL is fixed client-side. */
export interface ContactLinkCard {
  type: "contact_link";
  href: typeof LP_CONSULT_PATH;
  note?: string;
}

export const LP_CONSULT_PATH = "/lp/ai-employee/consult";

export type ChatCard = ProposalCard | HandoffPreviewCard | ContactLinkCard;

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
  if (r.type === "contact_link") {
    return {
      type: "contact_link",
      href: LP_CONSULT_PATH,
      note: typeof r.note === "string" ? r.note.slice(0, 200) : undefined,
    };
  }
  return null;
}

/**
 * How the launcher shows a card. A handoff card with the handoff flow OFF degrades to the
 * contact form link, so the visitor is never left with a dead "approve" step.
 */
export function chatCardView(
  card: ChatCard,
  handoffEnabled: boolean
): "proposal" | "handoff" | "contact" {
  if (card.type === "proposal_card") return "proposal";
  if (card.type === "handoff_preview") return handoffEnabled ? "handoff" : "contact";
  return "contact";
}

/** The handoff confirm page may edit/confirm only while the row is awaiting confirmation. */
export function isHandoffAwaitingConfirmation(status: string): boolean {
  return status === "pending_confirmation" || status === "pending";
}
