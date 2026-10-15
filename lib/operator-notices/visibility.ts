/**
 * Single visibility predicate. Demo store uses this; production SQL
 * `operator_notices_for_employee` is the same predicate. Callers MUST pass
 * orgId / employeeId / orgCreatedAt from the badge + orgs row — never from
 * tool arguments.
 */
import type { OperatorNotice, OperatorNoticeTarget, OperatorNoticeVersion, OperatorNoticeReceipt, VisibilityContext } from "./types";

export function isNoticeCurrentlyVisible(
  notice: Pick<
    OperatorNotice,
    "status" | "expiresAt" | "audienceScope" | "sticky" | "publishedAt" | "id"
  >,
  targets: OperatorNoticeTarget[],
  ctx: VisibilityContext
): boolean {
  if (notice.status !== "published") return false;
  const now = ctx.now ?? new Date();
  if (notice.expiresAt && Date.parse(notice.expiresAt) <= now.getTime()) return false;
  return noticeAudienceMatches(notice, targets, ctx);
}

/** Audience only (status / expiry ignored). Used so a withdrawn notice can still update receipts. */
export function noticeAudienceMatches(
  notice: Pick<OperatorNotice, "audienceScope" | "sticky" | "publishedAt" | "id">,
  targets: OperatorNoticeTarget[],
  ctx: Pick<VisibilityContext, "orgId" | "employeeId" | "orgCreatedAt">
): boolean {
  if (notice.audienceScope === "all") {
    if (notice.sticky) return true;
    if (!notice.publishedAt) return false;
    return Date.parse(notice.publishedAt) >= Date.parse(ctx.orgCreatedAt);
  }
  return targets.some(
    (t) =>
      t.noticeId === notice.id &&
      t.orgId === ctx.orgId &&
      (t.employeeId == null || t.employeeId === ctx.employeeId)
  );
}

export function latestVersion(
  versions: OperatorNoticeVersion[],
  noticeId: string,
  version: number
): OperatorNoticeVersion | null {
  return versions.find((v) => v.noticeId === noticeId && v.version === version) ?? null;
}

export function isNoticeUnread(
  notice: Pick<OperatorNotice, "id" | "version">,
  receipt: OperatorNoticeReceipt | null | undefined,
  latest: Pick<OperatorNoticeVersion, "kind"> | null
): boolean {
  if (!receipt) return true;
  if (receipt.state === "delivered") return true;
  if (
    receipt.ackedVersion != null &&
    receipt.ackedVersion < notice.version &&
    latest?.kind === "correction"
  ) {
    return true;
  }
  return false;
}

export function isPendingApply(
  notice: Pick<OperatorNotice, "applyMode">,
  receipt: OperatorNoticeReceipt | null | undefined
): boolean {
  if (notice.applyMode !== "self_rules" && notice.applyMode !== "instructions_via_approval") {
    return false;
  }
  if (!receipt) return true;
  return receipt.state === "delivered" || receipt.state === "read" || receipt.state === "needs_tenant_approval";
}

/** Ack may advance delivered→read→applied (and the terminal states); never reverse except on a newer version. */
export const TERMINAL_RECEIPT_STATES = ["applied", "not_applicable", "declined"] as const;

export function canAdvanceReceiptState(
  current: OperatorNoticeReceipt | null | undefined,
  next: OperatorNoticeReceipt["state"],
  noticeVersion: number
): boolean {
  if (!current) return true;
  if (current.ackedVersion != null && current.ackedVersion < noticeVersion) return true;
  if (current.state === next) return true;
  if ((TERMINAL_RECEIPT_STATES as readonly string[]).includes(current.state) && current.state !== next) {
    return false;
  }
  if (current.state === "read" && next === "applied") return true;
  if (current.state === "delivered") return true;
  if (current.state === "needs_tenant_approval" && (next === "applied" || next === "declined" || next === "not_applicable")) {
    return true;
  }
  if (current.state === "read" && (next === "not_applicable" || next === "declined" || next === "needs_tenant_approval")) {
    return true;
  }
  return false;
}
