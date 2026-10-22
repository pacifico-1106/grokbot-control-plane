/**
 * APPROVAL_APP_MISSING_SCOPE_NOTICE_ENABLED (default OFF, 木村 2026-10-12).
 *
 * A per-tenant custom approval app without a bot scope (users:read, im:write,
 * chat:write) fails setup.approvalDelivery.autoResolve /
 * setup.slackAuthorizeLink.issue with approval_app_missing_scope. That is not
 * transient: re-running before the tenant reinstalls the app cannot succeed.
 *
 * Flag ON:
 * - notifyApprovalAppMissingScope tells the approver of that ticket right away
 *   「この権限を足して入れ直して」 naming the scope (email to the approver when
 *   they are an active member of the org, else to its owners/admins; plus the
 *   org's OTHER enabled inboxes, never the failing one). Ids only: approval id,
 *   inbox id, app id, scope, tool. No request body, no token.
 * - lib/approvals/execution.ts treats the code as "may run again" for those two
 *   tools (every refusal precedes any write / post), so after the reinstall
 *   the SAME ticket runs again when the admin agent re-invokes it with approvalId.
 * - W2 (lib/stuck-watch/w2-unfulfilled.ts) does not spend automatic retries on
 *   it (reason fix_required); transient failures keep the maxAutoRetries cap.
 * The shared approval app (Staffpass's own app) is never the tenant's to
 * reinstall → no tenant notice for it.
 *
 * Flag OFF: nothing new. Data / delivery modules load lazily (execution.ts
 * imports the flag + sets from here).
 */
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";
import { adminAuditReason, appendAdminAuditEvent, resolveAdminAuditActor } from "@/lib/audit/admin-audit";

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export function isApprovalAppScopeNoticeEnabled(): boolean {
  return parseFlag(process.env.APPROVAL_APP_MISSING_SCOPE_NOTICE_ENABLED);
}

/**
 * APPROVAL_APP_FIX_REQUIRED_CODES_ENABLED (default OFF, #329 follow-up): the same
 * treatment for approval_user_external / approval_user_guest / bot_token_required.
 * Independent of the missing-scope flag (which may already be ON in production).
 */
export function isApprovalAppFixRequiredCodesEnabled(): boolean {
  return parseFlag(process.env.APPROVAL_APP_FIX_REQUIRED_CODES_ENABLED);
}

/** Refusals from openApprovalDeliveryDm that only a person can fix (all precede any write / post). */
export const APPROVAL_APP_FIX_REQUIRED_CODES = ["bot_token_required", "approval_user_guest", "approval_user_external"] as const;
export type ApprovalAppFixRequiredCode = (typeof APPROVAL_APP_FIX_REQUIRED_CODES)[number];
const FIX_REQUIRED_CODE_SET: ReadonlySet<string> = new Set(APPROVAL_APP_FIX_REQUIRED_CODES);

/** Codes Staffpass (not the tenant) fixes on the shared approval app → no tenant notice. */
const SHARED_APP_OPERATOR_CODES: ReadonlySet<string> = new Set(["approval_app_missing_scope", "bot_token_required"]);

/** This code's own flag is ON (missing scope → its flag; the three codes → the sibling flag). */
function codeFlagOn(code: string): boolean {
  if (code === "approval_app_missing_scope") return isApprovalAppScopeNoticeEnabled();
  return FIX_REQUIRED_CODE_SET.has(code) && isApprovalAppFixRequiredCodesEnabled();
}

/** Code with a notice + re-run + W2 skip when its flag is ON. */
export function isApprovalAppFixNoticeCode(code: string): boolean {
  return code === "approval_app_missing_scope" || FIX_REQUIRED_CODE_SET.has(code);
}

export const APPROVAL_APP_MISSING_SCOPE = "approval_app_missing_scope";

/** Approval-app tools whose approval_app_missing_scope refusal precedes any write / post. */
export const APPROVAL_APP_SCOPE_FIX_TOOLS: ReadonlySet<string> = new Set([
  "setup.approvalDelivery.autoResolve",
  "setup.slackAuthorizeLink.issue",
]);

/** Fulfilment codes W2 must not auto-retry (fix first, then re-invoke); each behind its flag. */
export const NON_TRANSIENT_FULFILMENT_CODES: ReadonlySet<string> = new Set([APPROVAL_APP_MISSING_SCOPE, ...APPROVAL_APP_FIX_REQUIRED_CODES]);

/** Flag ON + tool listed: the same ticket may run again after the fix. */
export function isApprovalAppScopeRetryable(tool: string, code: string): boolean {
  return NON_TRANSIENT_FULFILMENT_CODES.has(code) && APPROVAL_APP_SCOPE_FIX_TOOLS.has(tool) && codeFlagOn(code);
}

/** Flag ON: W2 leaves this fulfilment error to a person (no retry spent). */
export function isNonTransientFulfilmentError(code: string | undefined | null): boolean {
  return Boolean(code) && NON_TRANSIENT_FULFILMENT_CODES.has(String(code)) && codeFlagOn(String(code));
}

export const APPROVAL_APP_SCOPE_FIX_JA = "この権限を足して入れ直してください";
/** Per-code notice: what is wrong + how to fix it (no ids here; ids are added around it). */
export const APPROVAL_APP_FIX_NOTICE_JA: Record<ApprovalAppFixRequiredCode, { problem: string; fix: string; subject: string; rerun: "same" | "same_or_new" }> = {
  bot_token_required: {
    subject: "承認口に承認アプリの Bot token がありません",
    problem: "承認口に承認アプリの Bot User OAuth Token（xoxb-…）が入っていない、または形式が違います",
    fix: "owner/admin がダッシュボード /app/settings の「承認を受け取る」で、承認アプリの Bot User OAuth Token（xoxb-…）を入れ直してください（チャットには貼らないでください）",
    rerun: "same",
  },
  approval_user_guest: {
    subject: "承認 DM の相手がゲストユーザーです",
    problem: "承認 DM の相手が Slack のゲスト（シングル／マルチチャンネルゲスト）のため、承認 DM を開けません",
    fix: "承認者は社内のフルメンバーにしてください。Slack でその人をフルメンバーにした場合はそのまま、別の人にする場合は承認口の許可 user ID を直してから",
    rerun: "same_or_new",
  },
  approval_user_external: {
    subject: "承認 DM の相手が社外ユーザーです",
    problem: "承認 DM の相手が社外（Slack Connect）または承認アプリと別のワークスペースのユーザーのため、承認 DM を開けません",
    fix: "承認アプリと同じワークスペースの社内メンバーを、承認口の許可 user ID に設定してから",
    rerun: "same_or_new",
  },
};

const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const SCOPE_RE = /^[a-z:._]{1,40}$/;
const APP_ID_RE = /^A[A-Z0-9]{2,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW_MS = 10 * 60_000;
const MAX_CHANNELS = 3;
const MAX_EMAILS = 10;

function id(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return ID_RE.test(raw) ? raw : null;
}

/** `web:a@b.c` / `a@b.c` → email; `slack:U…` and others → null. */
function approverEmail(resolvedBy: unknown): string | null {
  const raw = typeof resolvedBy === "string" ? resolvedBy.trim().replace(/^web:/, "") : "";
  return EMAIL_RE.test(raw) ? raw.toLowerCase() : null;
}

type Mailer = (msg: { to: string[]; subject: string; text: string; html: string }) => Promise<{ ok: boolean }>;
type Sender = (channel: NotificationChannelRuntime, text: string) => Promise<{ ok: boolean }>;
let mailOverride: Mailer | null = null;
let sendOverride: Sender | null = null;
const throttle = new Map<string, number>();

export function setApprovalAppScopeNoticeDepsForTests(deps: { mail?: Mailer | null; send?: Sender | null }): void {
  if (deps.mail !== undefined) mailOverride = deps.mail;
  if (deps.send !== undefined) sendOverride = deps.send;
}

export function resetApprovalAppScopeNoticeForTests(): void {
  throttle.clear();
}

export function buildApprovalAppScopeNoticeJa(input: { scope: string; apiAppId: string | null; approvalId: string | null; tool: string }): string {
  const app = input.apiAppId ? `承認アプリ（App ID: ${input.apiAppId}）` : "承認アプリ";
  const where = input.apiAppId
    ? `https://api.slack.com/apps/${input.apiAppId}/oauth の Bot Token Scopes に ${input.scope} を追加 → Reinstall to Workspace`
    : `api.slack.com の OAuth & Permissions → Bot Token Scopes に ${input.scope} を追加 → Reinstall to Workspace`;
  return (
    `⚠️ StaffPass: ${app}に Slack の権限 ${input.scope} がありません。${APPROVAL_APP_SCOPE_FIX_JA}（${where}）。` +
    `入れ直した後、同じチケット${input.approvalId ? `（承認ID: ${input.approvalId}）` : ""}をもう一度実行できます。` +
    `管理エージェントに ${input.tool} を approvalId 付きで呼び直すよう伝えてください。自動の再実行はしません。`
  );
}

export function buildApprovalAppFixNoticeJa(input: {
  code: ApprovalAppFixRequiredCode;
  inboxId: string | null;
  approvalId: string | null;
  tool: string;
}): string {
  const w = APPROVAL_APP_FIX_NOTICE_JA[input.code];
  const ticket = `同じチケット${input.approvalId ? `（承認ID: ${input.approvalId}）` : ""}`;
  const rerun =
    w.rerun === "same"
      ? `入れ直した後、${ticket}をもう一度実行できます。管理エージェントに ${input.tool} を approvalId 付きで呼び直すよう伝えてください。`
      : `、${ticket}を呼び直してください（管理エージェントが ${input.tool} を approvalId 付きで）。相手を指定したチケットで相手を変える場合は、新しくチケットを作り直してください。`;
  return (
    `⚠️ StaffPass: ${w.problem}${input.inboxId ? `（承認口ID: ${input.inboxId}）` : ""}。` +
    `${w.fix}${w.rerun === "same" ? "。" : ""}${rerun}自動の再実行はしません。`
  );
}

export type ApprovalAppScopeNoticeResult = {
  status: "flag_off" | "skipped_shared_app" | "suppressed" | "invalid" | "sent";
  emails: number;
  channels: number;
};

/** approval_app_missing_scope notice (APPROVAL_APP_MISSING_SCOPE_NOTICE_ENABLED). Never throws. */
export async function notifyApprovalAppMissingScope(input: {
  orgId: string;
  approvalId: string | null;
  tool: string;
  inboxId: string | null;
  apiAppId?: string | null;
  scope: string;
  sharedApprovalApp?: boolean;
  now?: number;
}): Promise<ApprovalAppScopeNoticeResult> {
  return notifyApprovalAppFixRequired({ ...input, code: APPROVAL_APP_MISSING_SCOPE });
}

/**
 * One notice for any approval-app fix-required code (each behind its own flag):
 * missing scope → names the scope; the other three → their own wording.
 * Never throws; never changes the fulfilment outcome.
 */
export async function notifyApprovalAppFixRequired(input: {
  orgId: string;
  approvalId: string | null;
  tool: string;
  inboxId: string | null;
  code: string;
  apiAppId?: string | null;
  scope?: string;
  sharedApprovalApp?: boolean;
  now?: number;
}): Promise<ApprovalAppScopeNoticeResult> {
  const result: ApprovalAppScopeNoticeResult = { status: "flag_off", emails: 0, channels: 0 };
  const code = input.code;
  if (!isApprovalAppFixNoticeCode(code) || !codeFlagOn(code)) return result;
  if (input.sharedApprovalApp && SHARED_APP_OPERATOR_CODES.has(code)) return { ...result, status: "skipped_shared_app" };
  const isScope = code === APPROVAL_APP_MISSING_SCOPE;
  try {
    const orgId = id(input.orgId);
    const tool = APPROVAL_APP_SCOPE_FIX_TOOLS.has(input.tool) ? input.tool : null;
    const scope = isScope ? (SCOPE_RE.test(input.scope || "") ? input.scope! : null) : "-";
    if (!orgId || !tool || !scope) return { ...result, status: "invalid" };
    const approvalId = id(input.approvalId);
    const inboxId = id(input.inboxId);
    const apiAppId = typeof input.apiAppId === "string" && APP_ID_RE.test(input.apiAppId) ? input.apiAppId : null;

    const now = input.now ?? Date.now();
    const key = `${orgId}|${approvalId ?? "-"}|${inboxId ?? "-"}|${code}|${scope}`;
    const last = throttle.get(key);
    if (last !== undefined && now - last < WINDOW_MS) return { ...result, status: "suppressed" };
    if (throttle.size > 2_000) throttle.clear();
    throttle.set(key, now);

    const fixCode = code as ApprovalAppFixRequiredCode;
    const text = isScope
      ? buildApprovalAppScopeNoticeJa({ scope, apiAppId, approvalId, tool })
      : buildApprovalAppFixNoticeJa({ code: fixCode, inboxId, approvalId, tool });
    const [{ getApprovalById }, { listMembers }, { getEnabledNotificationChannels }] = await Promise.all([
      import("@/lib/data"),
      import("@/lib/data/members"),
      import("@/lib/data/notification-channels"),
    ]);

    // Approver of this ticket (same org only), else the org's owners/admins.
    const approval = approvalId ? await getApprovalById(approvalId, orgId).catch(() => null) : null;
    const members = (await listMembers(orgId).catch(() => [])).filter(
      (m) => m.orgId === orgId && m.status === "active" && EMAIL_RE.test(m.email || "")
    );
    const approver = approval && approval.orgId === orgId ? approverEmail(approval.resolvedBy) : null;
    const approverMember = approver ? members.find((m) => m.email.toLowerCase() === approver) : undefined;
    const to = approverMember
      ? [approverMember.email]
      : members.filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.email).slice(0, MAX_EMAILS);
    if (to.length) {
      const mail: Mailer =
        mailOverride ??
        (async (msg) => (await import("@/lib/resend")).sendTransactionalEmail({ ...msg, template: "approval_needed" }));
      const sent = await mail({
        to,
        subject: isScope ? `【要対応】承認アプリに Slack の権限 ${scope} がありません` : `【要対応】${APPROVAL_APP_FIX_NOTICE_JA[fixCode].subject}`,
        text,
        html: `<p>${text.replace(/[<>&]/g, "")}</p>`,
      }).catch(() => ({ ok: false }));
      if (sent.ok) result.emails = to.length;
    }

    // Other enabled inboxes of this org (never the failing one).
    const channels = (await getEnabledNotificationChannels(orgId).catch(() => []))
      .filter((c) => c.orgId === orgId && c.id !== inboxId)
      .slice(0, MAX_CHANNELS);
    let send = sendOverride;
    if (!send) {
      const [{ sendSlackTextToChannel }, { sendTelegramTextToChannel }, { sendLineText }] = await Promise.all([
        import("@/lib/notify/slack"),
        import("@/lib/notify/telegram"),
        import("@/lib/notify/line"),
      ]);
      send = async (channel, body) =>
        channel.provider === "telegram"
          ? sendTelegramTextToChannel(channel, body)
          : channel.provider === "line"
            ? sendLineText(channel, body)
            : sendSlackTextToChannel(channel, body);
    }
    for (const channel of channels) {
      const sent = await send(channel, text).catch(() => ({ ok: false }));
      if (sent.ok) result.channels += 1;
    }

    await appendAdminAuditEvent({
      actor: await resolveAdminAuditActor({
        orgId,
        fallbackHuman: { email: "slack_approval_app_notice" },
      }),
      orgId,
      employeeId: null,
      credentialId: null,
      action: "admin.notificationChannel",
      purpose: "admin.notificationChannel",
      target: { type: "org", id: orgId },
      reason: adminAuditReason("rejected"),
      result: "denied",
      summary: isScope
        ? `承認アプリに Slack の権限 ${scope} がないため、入れ直しを依頼しました（${tool}）`
        : `${APPROVAL_APP_FIX_NOTICE_JA[fixCode].subject}。直してからの再実行を依頼しました（${code} / ${tool}）`,
      metadata: {
        auditClass: "admin",
        event: isScope ? "approval_app.missing_scope_notice" : "approval_app.fix_required_notice",
        code,
        approvalId,
        inboxId,
        apiAppId,
        ...(isScope ? { scope } : {}),
        tool,
        notifiedApprover: Boolean(approverMember),
        emails: result.emails,
        channels: result.channels,
      },
    }).catch(() => undefined);
    return { ...result, status: "sent" };
  } catch {
    return { ...result, status: "invalid" };
  }
}
