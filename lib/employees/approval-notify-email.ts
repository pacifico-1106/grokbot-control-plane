/**
 * employee.approvalNotifyEmail — members only (木村 2026-10-05 mail tightening, item 1).
 *
 * The approval-result email may only go to an ACTIVE member of the employee's
 * own org (case-insensitive). Checked when it is set (every writer goes through
 * issueEmployee, which calls this) and again right before sending.
 * Stricter-only, so no flag (see the PR body).
 */
import { listMembers } from "@/lib/data/members";
import { normalizeIdentityEmail } from "@/lib/team/member-change-guard";
import { resolveAppOrigin } from "@/lib/app-url";
import { escapeHtml } from "@/lib/html-escape";
import { renderStubHtml } from "@/lib/resend";

export type ApprovalNotifyEmailErrorCode =
  | "approval_notify_email_invalid"
  | "approval_notify_email_not_member"
  | "approval_notify_email_unverified";

export type ApprovalNotifyEmailCheck =
  | { ok: true; email: string | null }
  | { ok: false; code: ApprovalNotifyEmailErrorCode; messageJa: string };

export const APPROVAL_NOTIFY_EMAIL_MESSAGES_JA: Record<ApprovalNotifyEmailErrorCode, string> = {
  approval_notify_email_invalid: "承認結果の通知先メールアドレスの形式が正しくありません（1 件だけ指定してください）。",
  approval_notify_email_not_member:
    "承認結果の通知先は、この組織の有効なメンバーのメールアドレスだけを指定できます。先にチームにメンバーとして追加してください。",
  approval_notify_email_unverified: "承認結果の通知先を確認できませんでした。時間をおいてもう一度お試しください。",
};

export class ApprovalNotifyEmailError extends Error {
  readonly code: ApprovalNotifyEmailErrorCode;
  constructor(code: ApprovalNotifyEmailErrorCode) {
    super(code);
    this.name = "ApprovalNotifyEmailError";
    this.code = code;
  }
}

// One address; no commas, spaces, angle brackets or quotes (no display-name / list tricks).
const SINGLE_ADDRESS = /^[^\s@,;<>"'()]+@[^\s@,;<>"'()]+\.[^\s@,;<>"'()]+$/;

function fail(code: ApprovalNotifyEmailErrorCode): ApprovalNotifyEmailCheck {
  return { ok: false, code, messageJa: APPROVAL_NOTIFY_EMAIL_MESSAGES_JA[code] };
}

/**
 * Set-time and send-time rule. Empty → no address (allowed). Otherwise the
 * address must equal (NFKC, trimmed, lower-cased) the email of an ACTIVE member
 * of `orgId`. Returns the member's own stored address. Lookup errors fail closed.
 */
export async function validateApprovalNotifyEmail(
  orgId: string | null | undefined,
  raw: unknown
): Promise<ApprovalNotifyEmailCheck> {
  if (raw === null || raw === undefined) return { ok: true, email: null };
  if (typeof raw !== "string") return fail("approval_notify_email_invalid");
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, email: null };
  if (trimmed.length > 254 || !SINGLE_ADDRESS.test(trimmed)) return fail("approval_notify_email_invalid");
  if (!orgId) return fail("approval_notify_email_not_member");
  const wanted = normalizeIdentityEmail(trimmed);
  let members;
  try {
    members = await listMembers(orgId);
  } catch {
    return fail("approval_notify_email_unverified");
  }
  const match = members.find(
    (m) => m.orgId === orgId && m.status === "active" && normalizeIdentityEmail(m.email) === wanted
  );
  if (!match) return fail("approval_notify_email_not_member");
  return { ok: true, email: match.email.trim() };
}

/** Set-time helper for writers: throws ApprovalNotifyEmailError when not allowed. */
export async function requireApprovalNotifyEmail(
  orgId: string | null | undefined,
  raw: unknown
): Promise<string | null> {
  const r = await validateApprovalNotifyEmail(orgId, raw);
  if (!r.ok) throw new ApprovalNotifyEmailError(r.code);
  return r.email;
}

/**
 * The approval-result email: only "an approval was decided" + a dashboard link.
 * No title, summary, purpose, tool, decision, approver, IDs or revision note.
 */
export function buildApprovalNotifyEmail(): { subject: string; text: string; html: string } {
  const href = `${resolveAppOrigin()}/app/approvals`;
  const lead = "AI社員の承認依頼に結論が出ました。内容はダッシュボードで確認してください。";
  return {
    subject: "[AI社員] 承認依頼に結論が出ました",
    text: `${lead}\n${href}\n`,
    html: renderStubHtml(
      "承認依頼に結論が出ました",
      `<p>${escapeHtml(lead)}</p><p><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></p>`
    ),
  };
}
