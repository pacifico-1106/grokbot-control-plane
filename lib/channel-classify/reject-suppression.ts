/**
 * #292 21:50 follow-up (木村 2026-10-09): a channel whose classification card
 * was REJECTED by a human gets no Path C wake-skip notice and no new card for
 * WAKE_SKIP_REJECT_SUPPRESS_DAYS (30) days. The audit records counts only: one
 * `channel_classify.wake_skip_suppressed` row per org × channel per 24h
 * (shared DB window via take_channel_stuck_notice; counts are per instance).
 *
 * Lifted when an admin newly files a channels.classify request for the same
 * channel (admin MCP ticket with adminRequester.kind "admin_agent", created
 * after the rejection). A system card, another channel's request or another
 * org's request never lifts it.
 *
 * Org-scoped: only approvals of the same org are read (query filtered by
 * org_id; demo rows re-checked). Read error → NOT suppressed (the previous
 * behaviour: notice + card under the existing caps / dedupe), because this is
 * noise control, never a reason to drop silently again.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { appendAuditEvent } from "@/lib/data/audit";
import { takeChannelStuckNoticeSlot } from "@/lib/data/channel-classify";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import type { ApprovalRequest } from "@/lib/types";

export const WAKE_SKIP_REJECT_SUPPRESS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPRESS_MS = WAKE_SKIP_REJECT_SUPPRESS_DAYS * DAY_MS;
/** Look-back for the query: a card created up to 60 days ago may have been rejected within 30. */
const LOOKBACK_MS = 60 * DAY_MS;
const AUDIT_WINDOW_SECONDS = 24 * 60 * 60;
const QUERY_LIMIT = 50;
const CHANNEL_RE = /^[CG][A-Z0-9]{2,30}$/;

let clock: () => number = () => Date.now();
export function setWakeSkipSuppressionClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

const counts = new Map<string, number>();

export type SuppressionApprovalRow = Pick<ApprovalRequest, "id" | "orgId" | "tool" | "status" | "createdAt" | "resolvedAt" | "metadata">;

async function classifyApprovalsForChannel(orgId: string, channelId: string, nowMs: number): Promise<SuppressionApprovalRow[] | null> {
  const since = new Date(nowMs - LOOKBACK_MS).toISOString();
  if (isDemoMode()) {
    const { listApprovals } = await import("@/lib/data/approvals");
    const all = await listApprovals(orgId);
    return all.filter(
      (a) =>
        a.orgId === orgId &&
        a.tool === "channels.classify" &&
        String((((a.metadata ?? {}) as Record<string, unknown>).adminMutation as Record<string, unknown> | undefined)?.externalId ?? "") === channelId &&
        a.createdAt >= since
    );
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("approval_requests")
    .select("id, org_id, tool, status, created_at, resolved_at, metadata")
    .eq("org_id", orgId)
    .eq("tool", "channels.classify")
    .eq("metadata->adminMutation->>externalId", channelId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(QUERY_LIMIT);
  if (error || !Array.isArray(data)) return null;
  return data
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id ?? ""),
        orgId: String(row.org_id ?? ""),
        tool: String(row.tool ?? ""),
        status: String(row.status ?? "") as ApprovalRequest["status"],
        createdAt: String(row.created_at ?? ""),
        resolvedAt: row.resolved_at != null ? String(row.resolved_at) : null,
        metadata: (row.metadata ?? {}) as ApprovalRequest["metadata"],
      };
    })
    .filter((a) => a.orgId === orgId);
}

function meta(a: SuppressionApprovalRow): Record<string, unknown> {
  return (a.metadata ?? {}) as Record<string, unknown>;
}

function isSystemCard(a: SuppressionApprovalRow): boolean {
  const req = meta(a).proposalRequester as Record<string, unknown> | undefined;
  return req?.kind === "system";
}

function isAdminRequest(a: SuppressionApprovalRow): boolean {
  const req = meta(a).adminRequester as Record<string, unknown> | undefined;
  return req?.kind === "admin_agent";
}

export type WakeSkipSuppression =
  | { suppressed: false }
  | { suppressed: true; rejectedApprovalId: string; suppressedUntil: string };

/**
 * Pure decision over approval rows (exported for tests). Rows of another org,
 * another channel or another tool are ignored here too (defence in depth on
 * top of the org-filtered query).
 */
export function decideWakeSkipSuppression(input: { rows: SuppressionApprovalRow[]; orgId: string; channelId: string; nowMs: number }): WakeSkipSuppression {
  const { orgId, channelId, nowMs } = input;
  const t = (iso: string | null | undefined) => {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : NaN;
  };
  const rows = input.rows.filter((a) => {
    const mutation = meta(a).adminMutation as Record<string, unknown> | undefined;
    return a.orgId === orgId && a.tool === "channels.classify" && String(mutation?.externalId ?? "") === channelId;
  });
  let latest: SuppressionApprovalRow | null = null;
  for (const a of rows) {
    if (a.status !== "rejected" || !isSystemCard(a)) continue;
    const at = t(a.resolvedAt);
    if (!Number.isFinite(at) || nowMs - at >= SUPPRESS_MS || at > nowMs + 60_000) continue;
    if (!latest || at > t(latest.resolvedAt)) latest = a;
  }
  if (!latest) return { suppressed: false };
  const rejectedAt = t(latest.resolvedAt);
  const lifted = rows.some((a) => isAdminRequest(a) && t(a.createdAt) >= rejectedAt);
  if (lifted) return { suppressed: false };
  return { suppressed: true, rejectedApprovalId: latest.id, suppressedUntil: new Date(rejectedAt + SUPPRESS_MS).toISOString() };
}

export async function wakeSkipSuppressionForRejectedCard(input: { orgId: string; channelId: string }): Promise<WakeSkipSuppression> {
  const { orgId, channelId } = input;
  if (!orgId || !CHANNEL_RE.test(channelId || "")) return { suppressed: false };
  try {
    const nowMs = clock();
    const rows = await classifyApprovalsForChannel(orgId, channelId, nowMs);
    if (!rows) return { suppressed: false };
    return decideWakeSkipSuppression({ rows, orgId, channelId, nowMs });
  } catch {
    return { suppressed: false };
  }
}

/** Counts-only audit: at most one row per org × channel per 24h. Never throws. */
export async function auditWakeSkipSuppressed(input: {
  orgId: string;
  channelId: string;
  rejectedApprovalId: string;
  suppressedUntil: string;
}): Promise<void> {
  const key = `${input.orgId}\u0000${input.channelId}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  try {
    const slot = await takeChannelStuckNoticeSlot({
      orgId: input.orgId,
      key: `wake_skip_rejected|slack:${input.channelId}`,
      windowSeconds: AUDIT_WINDOW_SECONDS,
    }).catch(() => ({ state: "unavailable" as const }));
    // Store unavailable → stay quiet (counts carry over to the next row).
    if (slot.state !== "ok" || !slot.allowed) return;
    const suppressedCount = counts.get(key) ?? 1;
    counts.delete(key);
    await appendAuditEvent({
      orgId: input.orgId,
      employeeId: null,
      credentialId: null,
      action: "channel_classify.wake_skip_suppressed",
      purpose: "admin.channel",
      summary: `分類カード却下後 ${WAKE_SKIP_REJECT_SUPPRESS_DAYS} 日間の抑止中: 未分類スキップ ${suppressedCount} 件の通知・カードを出していません`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        reason: "classify_card_rejected",
        surface: "slack",
        externalId: input.channelId,
        rejectedApprovalId: input.rejectedApprovalId,
        suppressedUntil: input.suppressedUntil,
        suppressedCount,
        windowHours: 24,
      },
    }).catch(() => undefined);
  } catch {
    // never throws
  }
}

export function resetWakeSkipSuppressionCountsForTests(): void {
  counts.clear();
}
