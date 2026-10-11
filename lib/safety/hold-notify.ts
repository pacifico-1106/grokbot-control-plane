/**
 * S3 notifications for stop / release (design §2.4, §2.6). IDs, kinds and a dashboard link
 * only — never the free-text reason (it may carry customer names), never key material.
 * Delivery failure never undoes a stop; the audit row / ops alert is the record.
 */
import { resolveAppOrigin as getAppUrl } from "@/lib/app-url";

export type HoldNoticeEvent =
  | "hold.started"
  | "hold.upgraded"
  | "hold.release_requested"
  | "hold.released"
  | "hold.start_failed";

export type HoldNotice = {
  event: HoldNoticeEvent;
  orgId: string;
  employeeId: string | null;
  holdId: string | null;
  kind?: string | null;
  via?: string | null;
  sqlState?: string | null;
  attempts?: number;
};

export type HoldNotifier = {
  tenant(n: HoldNotice): Promise<void>;
  ops(n: HoldNotice): Promise<void>;
};

const SUBJECT_JA: Record<HoldNoticeEvent, string> = {
  "hold.started": "AI社員を緊急停止しました",
  "hold.upgraded": "緊急停止をより強い停止に切り替えました",
  "hold.release_requested": "緊急停止の解除申請があります（ダッシュボードで承認してください）",
  "hold.released": "緊急停止を解除しました",
  "hold.start_failed": "【至急】緊急停止に失敗しました",
};

export function holdNoticeText(n: HoldNotice): string {
  const target = n.employeeId ? `AI社員 ${n.employeeId}` : "組織全体";
  const link = n.employeeId ? `${getAppUrl()}/app/employees/${n.employeeId}` : `${getAppUrl()}/app`;
  const lines = [`【Staffpass】${SUBJECT_JA[n.event]}`, `対象: ${target}`];
  if (n.holdId) lines.push(`停止ID: ${n.holdId}`);
  if (n.kind) lines.push(`種類: ${n.kind}`);
  if (n.event === "hold.release_requested") lines.push("解除の承認はダッシュボードからのみです（ログインし直して5分以内）。");
  lines.push(link);
  return lines.join("\n");
}

const defaultNotifier: HoldNotifier = {
  async tenant(n) {
    const { getEnabledNotificationChannels } = await import("@/lib/data/notification-channels");
    const { sendApprovalInboxText } = await import("@/lib/notify/channels");
    const channels = (await getEnabledNotificationChannels(n.orgId)).filter((c) => c.orgId === n.orgId);
    const chosen = channels.find((c) => c.isDefault) ?? channels[0] ?? null;
    if (chosen) await sendApprovalInboxText(chosen, holdNoticeText(n));
  },
  async ops(n) {
    console.error("employee_hold_ops_notice", {
      event: n.event, orgId: n.orgId, employeeId: n.employeeId, holdId: n.holdId, sqlState: n.sqlState ?? null, attempts: n.attempts ?? null,
    });
    const { appendAuditEvent } = await import("@/lib/data/audit");
    const opsOrgId = (process.env.PLATFORM_OPS_ORG_ID || "").trim();
    if (opsOrgId) {
      await appendAuditEvent({
        orgId: opsOrgId, employeeId: null, credentialId: null,
        action: n.event === "hold.start_failed" ? "employee.hold.start_failed" : "employee.hold.started",
        purpose: null, summary: `${SUBJECT_JA[n.event]}（org ${n.orgId}）`,
        metadata: { auditClass: "admin", ...n },
      }).catch(() => undefined);
    }
    const to = (process.env.APPROVAL_ALERT_OPS_EMAILS || "").split(",").map((x) => x.trim())
      .filter((x) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(x)).slice(0, 10);
    if (to.length) {
      const { sendTransactionalEmail } = await import("@/lib/resend");
      const text = holdNoticeText(n) + `\norg: ${n.orgId}` + (n.sqlState ? `\nsqlstate: ${n.sqlState}` : "") + (n.attempts ? `\nattempts: ${n.attempts}` : "");
      await sendTransactionalEmail({
        to, template: "oauth_security", subject: `【運営】${SUBJECT_JA[n.event]}`,
        html: `<pre>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string)}</pre>`, text,
        tags: [{ name: "template", value: "oauth_security" }],
      }).catch(() => undefined);
    }
  },
};

let override: HoldNotifier | null = null;
export function getHoldNotifier(): HoldNotifier {
  return override ?? defaultNotifier;
}
export function __setHoldNotifierForTests(n: HoldNotifier | null): void {
  override = n;
}

/** Never throws (a notice failure never undoes or blocks a stop). */
export async function notifyHold(n: HoldNotice, to: { tenant?: boolean; ops?: boolean }): Promise<void> {
  const notifier = getHoldNotifier();
  if (to.tenant) await notifier.tenant(n).catch((e) => console.error("employee_hold_tenant_notice_failed", { event: n.event, error: String(e) }));
  if (to.ops) await notifier.ops(n).catch((e) => console.error("employee_hold_ops_notice_failed", { event: n.event, error: String(e) }));
}
