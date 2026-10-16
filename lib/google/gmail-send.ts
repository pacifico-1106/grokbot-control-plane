/**
 * Live mail.send via Gmail users.messages.send.
 * Flag MAIL_SEND_GMAIL_LIVE (default OFF). Tokens never logged. Raw MIME
 * never logged. Unknown outcomes (timeout / 5xx / network) are not retried.
 */
import {
  getEmployeeGoogleIdentity,
  getLinkedGoogleRefreshToken,
  markGoogleIdentityNeedsReauth,
} from "@/lib/data/google-identities";
import { isMailSendGmailLiveEnabled } from "@/lib/feature-flags";
import { refreshGoogleToken } from "@/lib/google/oauth";
import { GOOGLE_SCOPE_GMAIL_SEND, grantedScopesInclude } from "@/lib/google/scopes";
import { buildRfc822Message, gmailRawBase64Url, type Rfc822Attachment } from "@/lib/mail/rfc822";

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const SEND_TIMEOUT_MS = 15_000;

export type GmailSendRequest = {
  employeeId: string;
  /** Approval / employee org — refuse a row bound to another tenant. */
  orgId?: string;
  from?: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  attachments: Rfc822Attachment[];
};

export type GmailSendResult =
  | { ok: true; messageId: string; threadId?: string; mailbox: string }
  | { ok: false; code: string; unknown?: boolean };

export function normalizeMailboxEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function mailboxEquals(a: string, b: string): boolean {
  return normalizeMailboxEmail(a) === normalizeMailboxEmail(b) && Boolean(normalizeMailboxEmail(a));
}

export async function sendMailViaGmail(input: GmailSendRequest): Promise<GmailSendResult> {
  if (!isMailSendGmailLiveEnabled()) {
    return { ok: false, code: "mail_gmail_live_disabled" };
  }

  const identity = await getEmployeeGoogleIdentity(input.employeeId);
  if (!identity || identity.status !== "linked" || !identity.googleEmail) {
    return { ok: false, code: "mail_gmail_not_connected" };
  }
  const expectedOrg = input.orgId?.trim() || "";
  if (expectedOrg && identity.orgId !== expectedOrg) {
    return { ok: false, code: "mail_gmail_not_connected" };
  }
  if (!grantedScopesInclude(identity.grantedScopes, GOOGLE_SCOPE_GMAIL_SEND)) {
    return { ok: false, code: "mail_gmail_scope_missing" };
  }

  const mailbox = identity.googleEmail.trim();
  const from = (input.from || mailbox).trim();
  if (!mailboxEquals(from, mailbox)) {
    return { ok: false, code: "mail_from_mailbox_mismatch" };
  }

  const refreshToken = await getLinkedGoogleRefreshToken(input.employeeId);
  if (!refreshToken) {
    return { ok: false, code: "mail_gmail_not_connected" };
  }

  const tokenResponse = await refreshGoogleToken(refreshToken);
  if (!tokenResponse.access_token) {
    await markGoogleIdentityNeedsReauth(input.employeeId);
    return { ok: false, code: "mail_gmail_needs_reauth" };
  }

  let raw: string;
  try {
    raw = gmailRawBase64Url(
      buildRfc822Message({
        from: mailbox,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.body,
        inReplyTo: input.inReplyTo,
        references: input.references,
        attachments: input.attachments,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("mail_header_invalid")) {
      return { ok: false, code: "mail_header_invalid" };
    }
    return { ok: false, code: "mail_gmail_build_failed" };
  }

  const payload: Record<string, string> = { raw };
  if (input.threadId) payload.threadId = input.threadId;

  try {
    const response = await fetch(GMAIL_SEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenResponse.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.status === 401) {
      await markGoogleIdentityNeedsReauth(input.employeeId);
      return { ok: false, code: "mail_gmail_needs_reauth" };
    }
    if (response.status === 403) {
      return { ok: false, code: "mail_gmail_scope_missing" };
    }
    if (response.status === 429) {
      return { ok: false, code: "provider_rate_limited" };
    }
    if (response.status >= 500) {
      return { ok: false, code: "post_outcome_unknown", unknown: true };
    }
    if (!response.ok) {
      return { ok: false, code: "mail_gmail_rejected" };
    }
    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      threadId?: string;
    };
    if (!body.id) {
      return { ok: false, code: "post_outcome_unknown", unknown: true };
    }
    return { ok: true, messageId: body.id, threadId: body.threadId, mailbox };
  } catch {
    return { ok: false, code: "post_outcome_unknown", unknown: true };
  }
}
