/**
 * CREDENTIAL_EXPIRY_NOTICE_ENABLED (default OFF; 木村 2026-10-12): tell the
 * tenant BEFORE a 社員証 expires — 7 days before and the day before — in the
 * tenant's approval inbox (org default inbox, any provider: Slack / LINE /
 * Telegram via sendApprovalInboxText). Background: every TOKYO307 credential
 * expired 9/23–9/30 without warning and the OAuth consent screen showed 0
 * candidates.
 *
 * - Dedup: one claim per credential × threshold (credential_expiry_notices PK),
 *   taken BEFORE sending; released when the send fails (retried next run).
 * - Caps: ≤ MAX_PER_ORG_PER_RUN items per org per run (one message per org),
 *   ≤ MAX_PER_ORG_PER_DAY claims per org per 24h. The rest waits ("他 N 件").
 * - Content: AI社員 id, 社員証 id, expiry (JST) and a dashboard link per
 *   employee. No display names, no scopes, no key material.
 * - Tenant isolation: a credential whose employee is in another org (or
 *   missing) is skipped; the inbox must belong to the credential's org; each
 *   message carries only that org's ids.
 * - Audit (credential.expiry_notice): ids, thresholds, counts — no link, no text.
 */
import type { CredentialExpiryThreshold, ExpiringCredentialRow, ClaimResult } from "@/lib/data/credential-expiry-notices";
import type { AuditEvent } from "@/lib/types";
import { formatCredentialExpiryJa } from "@/lib/employees/credential-expiry";

export type { ExpiringCredentialRow };

export const CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_RUN = 10;
export const CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_DAY = 20;
const DAY_MS = 86_400_000;
const HORIZON_MS = 7 * DAY_MS;

/** "1d" when ≤ 1 day is left, "7d" when ≤ 7 days, else null (also for expired / unparsable). */
export function noticeThresholdFor(expiresAt: string, now: Date): CredentialExpiryThreshold | null {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  const left = ms - now.getTime();
  if (left <= 0) return null;
  if (left <= DAY_MS) return "1d";
  if (left <= HORIZON_MS) return "7d";
  return null;
}

export interface NoticeInbox {
  id: string;
  orgId: string;
  provider: string;
}

export interface NoticeDeps {
  now: () => Date;
  origin: () => string;
  listExpiring: (now: Date, horizonMs: number) => Promise<ExpiringCredentialRow[]>;
  claim: (row: ExpiringCredentialRow, threshold: CredentialExpiryThreshold) => Promise<ClaimResult>;
  release: (row: ExpiringCredentialRow, threshold: CredentialExpiryThreshold) => Promise<void>;
  isClaimed: (row: ExpiringCredentialRow, threshold: CredentialExpiryThreshold) => Promise<boolean>;
  countRecent: (orgId: string, since: Date) => Promise<number>;
  resolveInbox: (orgId: string) => Promise<NoticeInbox | null>;
  send: (inbox: NoticeInbox, text: string) => Promise<{ ok: boolean }>;
  audit: (event: Omit<AuditEvent, "id" | "createdAt">) => Promise<void>;
}

export interface NoticeItem {
  credentialId: string;
  employeeId: string;
  expiresAt: string;
  threshold: CredentialExpiryThreshold;
  daysLeft: number;
}

export interface NoticeRunResult {
  orgs: number;
  notified: number;
  sent: number;
  failed: number;
  deferred: number;
  cappedOrgs: number;
  noInbox: number;
  skippedMismatch: number;
}

export function credentialExpiryNoticeText(items: NoticeItem[], opts: { origin: string; deferred: number }): string {
  const lines = items.map((item) => {
    const when = item.threshold === "1d" ? "明日まで" : `あと ${item.daysLeft} 日`;
    return [
      `・AI社員 ${item.employeeId} / 社員証 ${item.credentialId}`,
      `  期限 ${formatCredentialExpiryJa(item.expiresAt)}（${when}）`,
      `  再発行: ${opts.origin}/app/employees/${encodeURIComponent(item.employeeId)}`,
    ].join("\n");
  });
  return [
    "⏰ StaffPass 社員証の有効期限が近づいています",
    "期限が切れると、その AI社員は MCP / OAuth で接続できなくなります。",
    "",
    ...lines,
    ...(opts.deferred > 0 ? ["", `他 ${opts.deferred} 件は次回お知らせします。`] : []),
  ].join("\n");
}

const safeId = (v: string) => /^[A-Za-z0-9_.:-]{1,80}$/.test(v);

export async function runCredentialExpiryNotices(deps?: NoticeDeps): Promise<NoticeRunResult> {
  const d = deps ?? (await defaultNoticeDeps());
  const now = d.now();
  const result: NoticeRunResult = { orgs: 0, notified: 0, sent: 0, failed: 0, deferred: 0, cappedOrgs: 0, noInbox: 0, skippedMismatch: 0 };
  const rows = await d.listExpiring(now, HORIZON_MS);
  const byOrg = new Map<string, Array<{ row: ExpiringCredentialRow; threshold: CredentialExpiryThreshold }>>();
  for (const row of rows) {
    if (!row.orgId || !row.employeeId || !row.credentialId || !safeId(row.employeeId) || !safeId(row.credentialId)) continue;
    if (row.employeeOrgId !== row.orgId) {
      result.skippedMismatch++;
      continue;
    }
    if (row.employeeStatus !== "active") continue;
    const threshold = noticeThresholdFor(row.expiresAt, now);
    if (!threshold) continue;
    const list = byOrg.get(row.orgId) ?? [];
    list.push({ row, threshold });
    byOrg.set(row.orgId, list);
  }

  for (const [orgId, candidates] of byOrg) {
    candidates.sort((a, b) => Date.parse(a.row.expiresAt) - Date.parse(b.row.expiresAt));
    const inbox = await d.resolveInbox(orgId).catch(() => null);
    if (!inbox || inbox.orgId !== orgId) {
      result.noInbox++;
      continue;
    }
    const recent = await d.countRecent(orgId, new Date(now.getTime() - DAY_MS)).catch(() => Number.POSITIVE_INFINITY);
    const budget = Math.max(0, Math.min(CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_RUN, CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_DAY - recent));
    const claimed: Array<{ row: ExpiringCredentialRow; threshold: CredentialExpiryThreshold }> = [];
    let pending = 0;
    for (const c of candidates) {
      if (claimed.length >= budget) {
        // Only count what is still unsent (a duplicate is not "waiting").
        pending++;
        continue;
      }
      const r = await d.claim(c.row, c.threshold).catch((): ClaimResult => "error");
      if (r === "claimed") claimed.push(c);
    }
    // Over-cap candidates that were already sent earlier are not "waiting".
    const deferred = pending > 0 ? await countUnclaimed(d, candidates.slice(candidates.length - pending)) : 0;
    result.deferred += deferred;
    if (budget < CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_RUN && deferred > 0) result.cappedOrgs++;
    if (claimed.length === 0) continue;
    result.orgs++;
    const items: NoticeItem[] = claimed.map(({ row, threshold }) => ({
      credentialId: row.credentialId,
      employeeId: row.employeeId,
      expiresAt: row.expiresAt,
      threshold,
      daysLeft: Math.max(1, Math.ceil((Date.parse(row.expiresAt) - now.getTime()) / DAY_MS)),
    }));
    const text = credentialExpiryNoticeText(items, { origin: d.origin(), deferred });
    const sent = await d.send(inbox, text).catch(() => ({ ok: false }));
    if (sent.ok) {
      result.sent++;
      result.notified += claimed.length;
    } else {
      result.failed++;
      for (const c of claimed) await d.release(c.row, c.threshold).catch(() => undefined);
    }
    await d
      .audit({
        orgId,
        employeeId: null,
        credentialId: null,
        action: "credential.expiry_notice",
        purpose: null,
        summary: sent.ok ? `社員証の期限通知（${claimed.length} 件）` : `社員証の期限通知に失敗（${claimed.length} 件、次回再送）`,
        metadata: {
          ok: sent.ok,
          provider: inbox.provider,
          channelId: inbox.id,
          deferred,
          items: items.map((i) => ({ credentialId: i.credentialId, employeeId: i.employeeId, threshold: i.threshold })),
        },
      })
      .catch(() => undefined);
  }
  return result;
}

/** Of the over-cap candidates, how many have not been sent yet (read-only check). A read error counts as unsent. */
async function countUnclaimed(
  d: NoticeDeps,
  rest: Array<{ row: ExpiringCredentialRow; threshold: CredentialExpiryThreshold }>
): Promise<number> {
  let n = 0;
  for (const c of rest) {
    if (!(await d.isClaimed(c.row, c.threshold).catch(() => false))) n++;
  }
  return n;
}

async function defaultNoticeDeps(): Promise<NoticeDeps> {
  const store = await import("@/lib/data/credential-expiry-notices");
  const { getEnabledNotificationChannels, appendAuditEvent } = await import("@/lib/data");
  const { sendApprovalInboxText } = await import("@/lib/notify/channels");
  const { resolveAppOrigin } = await import("@/lib/app-url");
  const runtime = new Map<string, Awaited<ReturnType<typeof getEnabledNotificationChannels>>[number]>();
  return {
    now: () => new Date(),
    origin: () => resolveAppOrigin(),
    listExpiring: store.listExpiringCredentials,
    claim: store.claimCredentialExpiryNotice,
    release: store.releaseCredentialExpiryNotice,
    isClaimed: store.isCredentialExpiryNoticeClaimed,
    countRecent: store.countRecentCredentialExpiryNotices,
    // Same inbox as admin-class approvals: the org default (else first enabled).
    resolveInbox: async (orgId) => {
      const channels = (await getEnabledNotificationChannels(orgId)).filter((c) => c.orgId === orgId);
      const chosen = channels.find((c) => c.isDefault) ?? channels[0] ?? null;
      if (chosen) runtime.set(chosen.id, chosen);
      return chosen ? { id: chosen.id, orgId: chosen.orgId, provider: chosen.provider } : null;
    },
    send: async (inbox, text) => {
      const channel = runtime.get(inbox.id);
      if (!channel || channel.orgId !== inbox.orgId) return { ok: false };
      return sendApprovalInboxText(channel, text);
    },
    audit: (event) => appendAuditEvent(event),
  };
}
