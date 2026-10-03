/**
 * APPROVAL_DELIVERY_FAILURE_ALERT — real-approval live check (PR-3).
 *
 * There is no test approval: the first real approval is the live check. When a
 * real approval card cannot be delivered, or a (signature-verified) Slack button
 * press cannot be processed, the approval stays NOT granted (unchanged
 * behavior, fail-closed) and, when this flag is ON:
 * - audit admin.notificationChannel (auditClass=admin → tenant dashboard change
 *   log), event approval_delivery.failed / approval_button.failed;
 * - tenant admins: a short text on the org's OTHER enabled approval inboxes
 *   (never the failing one) + email to active owner/admin members of that org;
 * - operators: audit mirror into PLATFORM_OPS_ORG_ID (ids + reason code only)
 *   + optional email to APPROVAL_ALERT_OPS_EMAILS.
 * Throttled to 1 alert per org × kind × inbox per 30 min (per instance).
 * Content: ids and short reason codes only — no approval body, no tokens.
 * Never throws; never changes the approval outcome.
 *
 * When OFF (default): nothing new happens (existing notification.delivery_failed
 * audit only).
 */
// Data / delivery modules are imported lazily inside the alert so that the
// hot paths importing this file (notify/channels, Slack interactivity) do not
// pick up new module edges when the flag is OFF.
import type { sendTransactionalEmail } from "@/lib/resend";
import type { AuditEvent } from "@/lib/types";

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export function isApprovalDeliveryFailureAlertEnabled(): boolean {
  return parseFlag(process.env.APPROVAL_DELIVERY_FAILURE_ALERT);
}

export type ApprovalFailureKind = "delivery_failed" | "button_failed";

export const APPROVAL_ALERT_WINDOW_MS = 30 * 60_000;
const MAX_THROTTLE_KEYS = 2_000;
const MAX_FALLBACK_CHANNELS = 3;
const MAX_EMAILS = 10;

type ThrottleEntry = { windowStart: number; suppressed: number };
const throttle = new Map<string, ThrottleEntry>();

export function resetApprovalAlertThrottleForTests(): void {
  throttle.clear();
}

type AuditWriter = (event: Omit<AuditEvent, "id" | "createdAt"> & { actorEmail?: string }) => Promise<void>;
type Mailer = typeof sendTransactionalEmail;
let writerOverride: AuditWriter | null = null;
let mailerOverride: Mailer | null = null;
export function setApprovalAlertDepsForTests(deps: { writer?: AuditWriter | null; mailer?: Mailer | null }): void {
  if (deps.writer !== undefined) writerOverride = deps.writer;
  if (deps.mailer !== undefined) mailerOverride = deps.mailer;
}

/** Reduce free text (e.g. a provider error) to a short, markup-free code. */
function code(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const slug = raw.replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return slug || fallback;
}

function id(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(raw) ? raw : null;
}

function takeSlot(key: string, now: number, force = false): { allowed: true; suppressed: number } | { allowed: false } {
  const entry = throttle.get(key);
  // force: a one-off event that must always alert (e.g. the shared approval app's
  // token was deleted — idempotent, so it happens once per install). It still
  // opens a window, so the follow-up generic alert for the same inbox is suppressed.
  if (!force && entry && now - entry.windowStart < APPROVAL_ALERT_WINDOW_MS) {
    entry.suppressed += 1;
    return { allowed: false };
  }
  if (!entry && throttle.size >= MAX_THROTTLE_KEYS) throttle.clear();
  throttle.set(key, { windowStart: now, suppressed: 0 });
  return { allowed: true, suppressed: entry?.suppressed ?? 0 };
}

function emailList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s))
    .slice(0, MAX_EMAILS);
}

export type ApprovalAlertResult = {
  status: "flag_off" | "invalid" | "suppressed" | "sent" | "error";
  fallbackChannels: number;
  tenantEmails: number;
  opsMirrored: boolean;
  opsEmails: number;
};

export async function alertApprovalDeliveryFailure(input: {
  orgId: string;
  kind: ApprovalFailureKind;
  approvalId?: string | null;
  provider?: string | null;
  channelId?: string | null;
  reason?: string | null;
  /** Short next step (Japanese, no URL) shown instead of the generic guidance. */
  nextStepJa?: string | null;
  /** Bypass the throttle window (still opens a new one). */
  force?: boolean;
  now?: number;
}): Promise<ApprovalAlertResult> {
  const result: ApprovalAlertResult = {
    status: "flag_off",
    fallbackChannels: 0,
    tenantEmails: 0,
    opsMirrored: false,
    opsEmails: 0,
  };
  if (!isApprovalDeliveryFailureAlertEnabled()) return result;
  try {
    const orgId = id(input.orgId);
    if (!orgId) return { ...result, status: "invalid" };
    const kind: ApprovalFailureKind = input.kind === "button_failed" ? "button_failed" : "delivery_failed";
    const reason = code(input.reason, "unknown");
    const approvalId = id(input.approvalId);
    const channelId = id(input.channelId);
    const provider = code(input.provider, "unknown");
    const slot = takeSlot(`${orgId}|${kind}|${channelId ?? "-"}`, input.now ?? Date.now(), input.force === true);
    const nextStepJa = typeof input.nextStepJa === "string" ? input.nextStepJa.replace(/[<>&]/g, "").trim().slice(0, 300) : "";
    if (!slot.allowed) return { ...result, status: "suppressed" };

    const event = kind === "button_failed" ? "approval_button.failed" : "approval_delivery.failed";
    const labelJa = kind === "button_failed" ? "承認ボタンを処理できませんでした" : "承認依頼を届けられませんでした";
    const write = writerOverride ?? (await import("@/lib/data/audit")).appendAuditEvent;
    await write({
      orgId,
      employeeId: null,
      credentialId: null,
      action: "admin.notificationChannel",
      purpose: "admin.notificationChannel",
      summary: `${labelJa}（${provider} / ${reason}）。承認はされていません`,
      metadata: {
        auditClass: "admin",
        event,
        approvalId,
        provider,
        channelId,
        reason,
        approvalGranted: false,
        ...(nextStepJa ? { nextStepJa } : {}),
        suppressedSinceLast: slot.suppressed,
        suppressWindowMinutes: APPROVAL_ALERT_WINDOW_MS / 60_000,
      },
    });

    const text =
      `⚠️ StaffPass: ${labelJa}（理由: ${reason}）。承認はされていません。` +
      (nextStepJa
        ? `${nextStepJa}。`
        : `/app/approvals で内容を確認し、承認口（/app/settings「承認を受け取る」）の設定を見直してください。`) +
      (approvalId ? ` 承認ID: ${approvalId}` : "");

    const [{ getEnabledNotificationChannels }, { listMembers }, { sendSlackTextToChannel }, { sendTelegramTextToChannel }, { sendLineText }] =
      await Promise.all([
        import("@/lib/data/notification-channels"),
        import("@/lib/data/members"),
        import("@/lib/notify/slack"),
        import("@/lib/notify/telegram"),
        import("@/lib/notify/line"),
      ]);
    // Tenant admins (same org only): other enabled inboxes, never the failing one.
    const channels = (await getEnabledNotificationChannels(orgId).catch(() => []))
      .filter((channel) => channel.orgId === orgId && channel.id !== channelId)
      .slice(0, MAX_FALLBACK_CHANNELS);
    for (const channel of channels) {
      const sent =
        channel.provider === "telegram"
          ? await sendTelegramTextToChannel(channel, text).catch(() => ({ ok: false }))
          : channel.provider === "line"
            ? await sendLineText(channel, text).catch(() => ({ ok: false }))
            : await sendSlackTextToChannel(channel, text).catch(() => ({ ok: false }));
      if (sent.ok) result.fallbackChannels += 1;
    }
    const mail = mailerOverride ?? (await import("@/lib/resend")).sendTransactionalEmail;
    const admins = (await listMembers(orgId).catch(() => []))
      .filter(
        (member) =>
          member.orgId === orgId &&
          member.status === "active" &&
          (member.role === "owner" || member.role === "admin") &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email || "")
      )
      .map((member) => member.email)
      .slice(0, MAX_EMAILS);
    if (admins.length) {
      const sent = await mail({
        to: admins,
        template: "approval_needed",
        subject: `【要確認】${labelJa}`,
        html: `<p>${text.replace(/[<>&]/g, "")}</p>`,
        text,
      }).catch(() => ({ ok: false }));
      if (sent.ok) result.tenantEmails = admins.length;
    }

    // Operators: ids + reason only.
    const opsOrgId = id(process.env.PLATFORM_OPS_ORG_ID);
    if (opsOrgId && opsOrgId !== orgId) {
      await write({
        orgId: opsOrgId,
        employeeId: null,
        credentialId: null,
        action: "admin.notificationChannel",
        purpose: "admin.notificationChannel",
        summary: `テナントの${labelJa}（${reason}）`,
        metadata: {
          auditClass: "admin",
          event: `${event}.ops_mirror`,
          targetOrgId: orgId,
          approvalId,
          provider,
          reason,
          approvalGranted: false,
        },
      }).catch(() => undefined);
      result.opsMirrored = true;
    }
    const opsEmails = emailList(process.env.APPROVAL_ALERT_OPS_EMAILS);
    if (opsEmails.length) {
      const opsText = `${text} 対象org: ${orgId}`;
      const sent = await mail({
        to: opsEmails,
        template: "approval_needed",
        subject: `【運営】テナントの${labelJa}`,
        html: `<p>${opsText.replace(/[<>&]/g, "")}</p>`,
        text: opsText,
      }).catch(() => ({ ok: false }));
      if (sent.ok) result.opsEmails = opsEmails.length;
    }
    return { ...result, status: "sent" };
  } catch (error) {
    console.error("approval_delivery_alert_failed", error instanceof Error ? code(error.message, "error") : "error");
    return { ...result, status: "error" };
  }
}
