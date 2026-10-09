/**
 * PR-B stuck notifications (CHANNEL_STUCK_NOTIFY_ENABLED, default OFF).
 *
 * Something that silently blocks work gets a short notice to a human:
 *   unregistered_channel_denied  a post denied (external_confidential_denied)
 *                                in a channel the ledger does not know
 *   ledger_write_failed          ext-shared ledger write failed (audience stays external)
 *   ledger_read_failed           ledger read failed during the stuck-watch retry
 *   backfill_failed              joined-channel backfill failed
 *   proposal_failed              classification ticket could not be opened
 *   stuck_watch_mouth_fallback   stuck-watch alert whose notifyMouth is unset / missing
 *   proposal_rate_limited        the org hit the hourly proposal cap (one per window)
 *   unclassified_channel_wake_skipped  Path C: a mention in an unclassified channel
 *                                did not wake the employee (same 6h window as the deny notice)
 *
 * Routing (same org only): the employee's approval channel → the org's
 * default (else first) enabled approval channel → ops (PLATFORM_OPS_ORG_ID
 * audit mirror, ids only, + APPROVAL_ALERT_OPS_EMAILS) → "undelivered".
 * A tenant audit row (channel_stuck.notice) is always written.
 * Rate-limited per org × kind × channel (DB window; per-instance fallback when
 * the store is unavailable), then capped per org per hour (H1,
 * CHANNEL_STUCK_MAX_NOTICES_PER_HOUR): over the cap → ONE summary notice, then
 * "rate_limited" until the window rolls. Content: ids, reason codes, next
 * step — never a message body, token or secret. Never throws.
 *
 * notifyOpsIdsOnly(): ops-only notice (audit mirror + ops mail, ids only) for
 * conditions the tenant cannot be told through its own approval channel
 * (no admin approver). Rate-limited per org × reason.
 */
import { isChannelStuckNotifyEnabled } from "@/lib/channel-classify/flags";
import { takeChannelStuckNoticeSlot } from "@/lib/data/channel-classify";
import { buildUnregisteredDenyNoticeJa, surfaceLabel, type ProposalState } from "@/lib/channel-classify/core";
import { maxNoticesPerHour, takeOrgBudget } from "@/lib/channel-classify/budget";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";
import type { AuditEvent } from "@/lib/types";

export type StuckNoticeKind =
  | "unregistered_channel_denied"
  | "ledger_write_failed"
  | "ledger_read_failed"
  | "backfill_failed"
  | "proposal_failed"
  | "stuck_watch_mouth_fallback"
  | "proposal_rate_limited"
  | "unclassified_channel_wake_skipped";

const KINDS = new Set<StuckNoticeKind>([
  "unregistered_channel_denied",
  "ledger_write_failed",
  "ledger_read_failed",
  "backfill_failed",
  "proposal_failed",
  "stuck_watch_mouth_fallback",
  "proposal_rate_limited",
  "unclassified_channel_wake_skipped",
]);

export type StuckNoticeInput = {
  orgId: string;
  kind: StuckNoticeKind;
  ref?: { surface: string; externalId: string } | null;
  reason: string;
  approvalId?: string | null;
  proposalState?: ProposalState;
  employee?: { approvalChannelId?: string | null } | null;
  /** Pre-built alert text (stuck_watch_mouth_fallback only; already body-free). */
  text?: string;
  dedupeKey?: string;
  /** proposal_rate_limited: the hourly cap that was hit. */
  limit?: number;
};

export type StuckNoticeResult = {
  status: "flag_off" | "invalid" | "suppressed" | "rate_limited" | "sent_approver" | "sent_default" | "sent_ops" | "undelivered" | "error";
  channelId?: string;
  provider?: string;
  /** H1: this notice was replaced by the org's one hourly-cap summary. */
  summary?: boolean;
};

type AuditInput = Omit<AuditEvent, "id" | "createdAt">;
type Deps = {
  listChannels: (orgId: string) => Promise<NotificationChannelRuntime[]>;
  send: (channel: NotificationChannelRuntime, text: string) => Promise<{ ok: boolean; error?: string }>;
  audit: (event: AuditInput) => Promise<void>;
  mail: (input: { to: string[]; subject: string; text: string; html: string; template: "approval_needed" }) => Promise<{ ok: boolean }>;
};

const DEFAULT_DEPS: Deps = {
  listChannels: async (orgId) => (await import("@/lib/data/notification-channels")).getEnabledNotificationChannels(orgId),
  send: async (channel, text) => {
    if (channel.provider === "telegram") return (await import("@/lib/notify/telegram")).sendTelegramTextToChannel(channel, text);
    if (channel.provider === "line") return (await import("@/lib/notify/line")).sendLineText(channel, text);
    return (await import("@/lib/notify/slack")).sendSlackTextToChannel(channel, text);
  },
  audit: async (event) => {
    await (await import("@/lib/data/audit")).appendAuditEvent(event);
  },
  mail: async (input) => (await import("@/lib/resend")).sendTransactionalEmail(input),
};
let deps: Deps = DEFAULT_DEPS;

export function setStuckNotifyDepsForTests(override: Partial<Deps> | null): void {
  deps = override ? { ...DEFAULT_DEPS, ...override } : DEFAULT_DEPS;
  fallbackThrottle.clear();
}

export const DENY_NOTICE_WINDOW_SECONDS = 6 * 60 * 60;
export const OTHER_NOTICE_WINDOW_SECONDS = 30 * 60;
const MAX_FALLBACK_KEYS = 2_000;
const MAX_EMAILS = 10;
const fallbackThrottle = new Map<string, number>();

function id(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_.:@+-]{1,128}$/.test(raw) ? raw : null;
}

function code(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const slug = raw.replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return slug || fallback;
}

function noticeKey(input: StuckNoticeInput, ref: { surface: string; externalId: string } | null): string {
  const raw = input.dedupeKey ? `${input.kind}|${input.dedupeKey}` : `${input.kind}|${ref ? `${ref.surface}:${ref.externalId}` : "-"}`;
  return raw.replace(/[^A-Za-z0-9_.:@+|-]+/g, "_").slice(0, 200) || input.kind;
}

async function takeSlot(orgId: string, key: string, windowSeconds: number): Promise<boolean> {
  const slot = await takeChannelStuckNoticeSlot({ orgId, key, windowSeconds }).catch(() => ({ state: "unavailable" as const }));
  if (slot.state === "ok") return slot.allowed;
  // Store unavailable / denied: still rate-limit per instance (never spam, never silent).
  const now = Date.now();
  const mapKey = `${orgId}|${key}`;
  const last = fallbackThrottle.get(mapKey);
  if (last !== undefined && now - last < windowSeconds * 1000) return false;
  if (fallbackThrottle.size >= MAX_FALLBACK_KEYS) fallbackThrottle.clear();
  fallbackThrottle.set(mapKey, now);
  return true;
}

function clip(text: string, max: number): string {
  return text.replace(/[<>]/g, "").slice(0, max);
}

export function buildStuckNoticeTextJa(input: StuckNoticeInput, ref: { surface: string; externalId: string } | null, reason: string): string {
  const where = ref ? `${surfaceLabel(ref.surface)} ${ref.externalId}` : "";
  switch (input.kind) {
    case "unregistered_channel_denied":
      return buildUnregisteredDenyNoticeJa({
        ref: ref ?? { surface: "unknown", externalId: "-" },
        reason,
        approvalId: id(input.approvalId),
        proposalState: input.proposalState,
      });
    case "ledger_write_failed":
    case "ledger_read_failed":
      return [
        `⚠️ Staffpass: チャネル台帳の${input.kind === "ledger_write_failed" ? "更新" : "読み取り"}に失敗しました${where ? `（${where}）` : ""}`,
        `理由: ${reason}。安全側（社外扱い）のまま投稿は止めています。`,
        `対処: 管理エージェントの channels.list で登録状態を確認し、必要なら channels.classify を依頼してください。`,
      ].join("\n");
    case "backfill_failed":
      return [
        `⚠️ Staffpass: 参加済みチャネルの分類提案（backfill）に失敗しました`,
        `理由: ${reason}。提案は作られていません。次回の実行で再試行します。`,
        `対処: ボットの権限（channels:read / groups:read / users:read）を確認してください。`,
      ].join("\n");
    case "proposal_failed":
      return [
        `⚠️ Staffpass: チャネル分類の提案チケットを作れませんでした${where ? `（${where}）` : ""}`,
        `理由: ${reason}。未登録のチャネルは社外扱いのままです。`,
        ref
          ? `対処: 管理エージェントで channels.classify（surface=${ref.surface}, externalId=${ref.externalId}）を依頼してください。`
          : `対処: 管理エージェントで channels.classify を依頼してください。`,
      ].join("\n");
    case "stuck_watch_mouth_fallback":
      return `${clip(input.text || "⚠️ Staffpass: 滞留アラート", 1200)}\n（通知先 notifyMouth が未設定または無効のため、承認窓口へ届けています）`;
    case "unclassified_channel_wake_skipped": {
      const approvalId = id(input.approvalId);
      const lines = [
        `⚠️ Staffpass: 分類が未登録のチャネルでのメンションに社員が反応できませんでした${where ? `（${where}）` : ""}`,
        `理由: ${reason} — 未登録のチャネルでは安全のため社員を起こしません。本文は含めていません。`,
      ];
      if (approvalId && (input.proposalState === undefined || input.proposalState === "created" || input.proposalState === "pending")) {
        lines.push(`対処: 承認窓口に届いている分類チケット（channels.classify）を承認すると、以降のメンションで起きるようになります（承認ID: ${approvalId}）。社外の場合は社外として分類してください（管理エージェントで channels.classify に classification=shared_external を指定）。却下は、この AI 社員にこのチャネルを対応させたくない場合だけにしてください。`);
      } else if (approvalId && input.proposalState === "decided") {
        lines.push(`分類チケットは処理済みです（承認ID: ${approvalId}）。変える場合は管理エージェントで channels.classify を依頼してください。`);
      } else if (ref) {
        lines.push(`対処: 管理エージェントで channels.classify（surface=${ref.surface}, externalId=${ref.externalId}）を依頼し、承認してください。`);
      } else {
        lines.push(`対処: 管理エージェントで channels.classify を依頼し、承認してください。`);
      }
      return lines.join("\n");
    }
    case "proposal_rate_limited":
      return [
        `⚠️ Staffpass: チャネル分類の自動提案が 1 時間あたりの上限（${limitText(input.limit)}件）に達しました`,
        `この 1 時間は新しい提案を作りません。未登録のチャネルは社外扱いのままです。`,
        `対処: 管理エージェントの channels.list で登録状態を確認し、必要なチャネルだけ channels.classify を依頼してください。`,
      ].join("\n");
  }
}

function limitText(limit: unknown): string {
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? String(limit) : "-";
}

export function buildNoticeCapSummaryJa(limit: number): string {
  return [
    `⚠️ Staffpass: 滞留通知が 1 時間あたりの上限（${limitText(limit)}件）に達しました`,
    `この 1 時間は以降の通知を止めます（件数は記録されます）。`,
    `対処: 管理エージェントの channels.list で未登録・失敗中のチャネルを確認してください。`,
  ].join("\n");
}

export async function notifyChannelStuck(input: StuckNoticeInput): Promise<StuckNoticeResult> {
  if (!isChannelStuckNotifyEnabled()) return { status: "flag_off" };
  try {
    const orgId = id(input.orgId);
    if (!orgId || !KINDS.has(input.kind)) return { status: "invalid" };
    const ref = input.ref && id(input.ref.externalId) && /^[a-z]{2,12}$/.test(input.ref.surface)
      ? { surface: input.ref.surface, externalId: input.ref.externalId.trim() }
      : null;
    const reason = code(input.reason, "unknown");
    const key = noticeKey(input, ref);
    const windowSeconds = input.kind === "unregistered_channel_denied" || input.kind === "unclassified_channel_wake_skipped" ? DENY_NOTICE_WINDOW_SECONDS : OTHER_NOTICE_WINDOW_SECONDS;
    if (!(await takeSlot(orgId, key, windowSeconds))) return { status: "suppressed" };

    // H1: per-org hourly cap. The proposal-cap summary is itself capped (once
    // per proposal window) and must not be eaten by the notice cap.
    let text = buildStuckNoticeTextJa(input, ref, reason);
    let summary = false;
    if (input.kind !== "proposal_rate_limited") {
      const limit = maxNoticesPerHour();
      const verdict = await takeOrgBudget(orgId, "notices", limit);
      if (verdict === "over") return { status: "rate_limited" };
      if (verdict === "over_first") {
        text = buildNoticeCapSummaryJa(limit);
        summary = true;
      }
    }
    const channels = (await deps.listChannels(orgId).catch(() => [] as NotificationChannelRuntime[])).filter(
      (channel) => channel.orgId === orgId && channel.enabled !== false
    );
    const preferredId = id(input.employee?.approvalChannelId);
    const preferred = preferredId ? channels.find((channel) => channel.id === preferredId) : undefined;
    const others = channels.filter((channel) => channel !== preferred);
    const fallback = others.find((channel) => channel.isDefault) ?? others[0];

    let result: StuckNoticeResult = { status: "undelivered" };
    const trySend = async (channel: NotificationChannelRuntime | undefined, status: "sent_approver" | "sent_default") => {
      if (!channel) return false;
      const sent = await deps.send(channel, text).catch(() => ({ ok: false }));
      if (sent.ok) result = { status, channelId: channel.id, provider: channel.provider, ...(summary ? { summary } : {}) };
      return sent.ok;
    };
    if (!(await trySend(preferred, "sent_approver"))) await trySend(fallback, "sent_default");

    if (result.status === "undelivered") {
      let opsReached = false;
      const opsOrgId = id(process.env.PLATFORM_OPS_ORG_ID);
      if (opsOrgId && opsOrgId !== orgId) {
        const mirrored = await deps
          .audit({
            orgId: opsOrgId,
            employeeId: null,
            credentialId: null,
            action: "channel_stuck.notice",
            purpose: "admin.channel",
            summary: `テナントの滞留通知を届けられませんでした（${input.kind} / ${reason}）`,
            metadata: {
              auditClass: "admin",
              event: `channel_stuck.${input.kind}.ops_mirror`,
              targetOrgId: orgId,
              surface: ref?.surface ?? null,
              externalId: ref?.externalId ?? null,
              reason,
              approvalId: id(input.approvalId),
            },
          })
          .then(() => true)
          .catch(() => false);
        opsReached = opsReached || mirrored;
      }
      const opsEmails = (process.env.APPROVAL_ALERT_OPS_EMAILS || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s))
        .slice(0, MAX_EMAILS);
      if (opsEmails.length) {
        const opsText = `${text}\n対象org: ${orgId}`;
        const mailed = await deps
          .mail({
            to: opsEmails,
            template: "approval_needed",
            subject: "【運営】テナントの滞留通知（承認窓口に届きませんでした）",
            html: `<p>${opsText.replace(/[<>&]/g, "").replace(/\n/g, "<br>")}</p>`,
            text: opsText,
          })
          .catch(() => ({ ok: false }));
        opsReached = opsReached || mailed.ok;
      }
      if (opsReached) result = { status: "sent_ops", ...(summary ? { summary } : {}) };
    }

    await deps
      .audit({
        orgId,
        employeeId: null,
        credentialId: null,
        action: "channel_stuck.notice",
        purpose: "admin.channel",
        summary: `滞留通知（${input.kind} / ${reason}）${ref ? `: ${surfaceLabel(ref.surface)} ${ref.externalId}` : ""}`,
        metadata: {
          auditClass: "admin",
          event: `channel_stuck.${input.kind}`,
          surface: ref?.surface ?? null,
          externalId: ref?.externalId ?? null,
          reason,
          approvalId: id(input.approvalId),
          delivery: result.status,
          channelId: result.channelId ?? null,
          ...(summary ? { capSummary: true } : {}),
        },
      })
      .catch(() => undefined);
    return result;
  } catch {
    return { status: "error" };
  }
}

export const OPS_NOTICE_WINDOW_SECONDS = 6 * 60 * 60;

/**
 * Ops-only notice, ids only (org id, surface, external id, reason code,
 * trigger): PLATFORM_OPS_ORG_ID audit mirror + APPROVAL_ALERT_OPS_EMAILS.
 * Rate-limited per org × reason. Not gated on CHANNEL_STUCK_NOTIFY_ENABLED
 * (the caller's own flag decides). Never throws.
 */
export async function notifyOpsIdsOnly(input: {
  orgId: string;
  reason: "no_admin_approver";
  ref?: { surface: string; externalId: string } | null;
  trigger?: string;
}): Promise<"sent_ops" | "suppressed" | "undelivered" | "invalid"> {
  try {
    const orgId = id(input.orgId);
    if (!orgId) return "invalid";
    const ref = input.ref && id(input.ref.externalId) && /^[a-z]{2,12}$/.test(input.ref.surface)
      ? { surface: input.ref.surface, externalId: input.ref.externalId.trim() }
      : null;
    const trigger = code(input.trigger, "-");
    if (!(await takeSlot(orgId, `ops|${input.reason}`, OPS_NOTICE_WINDOW_SECONDS))) return "suppressed";
    let reached = false;
    const opsOrgId = id(process.env.PLATFORM_OPS_ORG_ID);
    if (opsOrgId && opsOrgId !== orgId) {
      reached = await deps
        .audit({
          orgId: opsOrgId,
          employeeId: null,
          credentialId: null,
          action: "channel_stuck.notice",
          purpose: "admin.channel",
          summary: `テナントに管理承認者がいないため分類提案を作りませんでした（${input.reason}）`,
          metadata: {
            auditClass: "admin",
            event: `channel_classify.${input.reason}.ops`,
            targetOrgId: orgId,
            surface: ref?.surface ?? null,
            externalId: ref?.externalId ?? null,
            reason: input.reason,
            trigger,
          },
        })
        .then(() => true)
        .catch(() => false);
    }
    const opsEmails = (process.env.APPROVAL_ALERT_OPS_EMAILS || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s))
      .slice(0, MAX_EMAILS);
    if (opsEmails.length) {
      const text = [
        "【運営】管理承認者がいない org のため、チャネル分類の提案チケットを作りませんでした",
        `org: ${orgId}`,
        `チャネル: ${ref ? `${ref.surface} ${ref.externalId}` : "-"}`,
        `理由: ${input.reason} / trigger: ${trigger}`,
        "対処: org の管理承認ルート（またはオーナー）の設定状況を確認してください。",
      ].join("\n");
      const mailed = await deps
        .mail({
          to: opsEmails,
          template: "approval_needed",
          subject: "【運営】管理承認者未設定の org（分類提案を停止）",
          html: `<p>${text.replace(/[<>&]/g, "").replace(/\n/g, "<br>")}</p>`,
          text,
        })
        .catch(() => ({ ok: false }));
      reached = reached || mailed.ok;
    }
    return reached ? "sent_ops" : "undelivered";
  } catch {
    return "undelivered";
  }
}
