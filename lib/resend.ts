import { Resend } from "resend";
import { escapeHtml, sanitizeEmailSubject } from "@/lib/html-escape";
import { SERVICE_LABEL } from "@/lib/brand";
import { isMailUnverifiedFromEnabled } from "@/lib/feature-flags";

export type MailAudience = "verified" | "unverified";

export type EmailTemplate =
  | "welcome"
  | "trial_started"
  | "trial_ending"
  | "billing_receipt"
  | "approval_requested"
  | "approval_needed"
  | "approval_resolved"
  | "oauth_connected"
  | "oauth_security"
  | "lp_ops_alert";

export interface SendEmailInput {
  to: string | string[];
  template: EmailTemplate;
  subject: string;
  html: string;
  text?: string;
  tags?: Array<{ name: string; value: string }>;
  /**
   * Default verified. welcome / trial_started are always unverified
   * (flag ON only), even if this is omitted or set to verified.
   */
  audience?: MailAudience;
}

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key || key.startsWith("replace_me")) {
    return null;
  }
  return new Resend(key);
}

export function getEmailFrom(): string {
  return (
    process.env.EMAIL_FROM ||
    `${SERVICE_LABEL} <noreply@example.com>`
  );
}

export type TransactionalFromError =
  | "unverified_from_unconfigured"
  | "unverified_from_invalid";

export type TransactionalFromResult =
  | { ok: true; from: string }
  | { ok: false; error: TransactionalFromError };

/** welcome / trial_started are always unverified, even if callers pass verified. */
export function effectiveMailAudience(
  template: EmailTemplate,
  audience?: MailAudience
): MailAudience {
  if (template === "welcome" || template === "trial_started") {
    return "unverified";
  }
  return audience ?? "verified";
}

function hasDisallowedControlChars(value: string): boolean {
  return /[\u0000-\u001F\u007F\u0080-\u009F]/.test(value);
}

/**
 * Choose From for a transactional send.
 * Unverified From is used only when the flag is ON and EMAIL_FROM_UNVERIFIED
 * is set. Missing env while the flag is ON is fail-closed (no EMAIL_FROM fallback).
 * Control characters / newlines in EMAIL_FROM_UNVERIFIED also refuse the send.
 */
export function resolveTransactionalFrom(
  audience: MailAudience = "verified"
): TransactionalFromResult {
  if (audience === "unverified" && isMailUnverifiedFromEnabled()) {
    const unverified = (process.env.EMAIL_FROM_UNVERIFIED ?? "").trim();
    if (!unverified) {
      return { ok: false, error: "unverified_from_unconfigured" };
    }
    if (hasDisallowedControlChars(unverified)) {
      return { ok: false, error: "unverified_from_invalid" };
    }
    if (unverified === getEmailFrom().trim()) {
      // Do not log the From value or any recipient.
      console.warn(
        "[resend] unverified_from_matches_production_from (EMAIL_FROM_UNVERIFIED equals EMAIL_FROM; replay isolation is ineffective)"
      );
    }
    return { ok: true, from: unverified };
  }
  return { ok: true, from: getEmailFrom() };
}

/**
 * All transactional email goes through Resend.
 * Returns stub result when API key is not configured (local / preview).
 */
export async function sendTransactionalEmail(input: SendEmailInput): Promise<{
  ok: boolean;
  id?: string;
  stub?: boolean;
  error?: string;
}> {
  const subject = sanitizeEmailSubject(input.subject);
  const resolved = resolveTransactionalFrom(
    effectiveMailAudience(input.template, input.audience)
  );
  if (!resolved.ok) {
    // Do not log the recipient or the From value: unverified paths can be attacker-chosen.
    const reason =
      resolved.error === "unverified_from_invalid"
        ? "EMAIL_FROM_UNVERIFIED has control characters"
        : "EMAIL_FROM_UNVERIFIED missing";
    console.warn(
      `[resend] ${resolved.error} template=${input.template} (MAIL_UNVERIFIED_FROM_ENABLED on, ${reason}; refusing send)`
    );
    return { ok: false, error: resolved.error };
  }

  const resend = getResend();
  if (!resend) {
    console.info("[resend:stub]", input.template, subject);
    return { ok: true, id: `stub_${Date.now()}`, stub: true };
  }

  const { data, error } = await resend.emails.send({
    from: resolved.from,
    to: input.to,
    subject,
    html: input.html,
    text: input.text,
    tags: input.tags,
  });

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, id: data?.id };
}

/**
 * Wrap an email body. `title` is plain text and is escaped here; `body` is
 * trusted HTML — callers must escape every user-controlled value in it.
 */
export function renderStubHtml(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;color:#111;background:#fafafa;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:24px">
    <p style="margin:0 0 8px;font-size:12px;color:#737373">${escapeHtml(SERVICE_LABEL)}</p>
    <h1 style="margin:0 0 16px;font-size:20px;font-weight:600">${escapeHtml(title)}</h1>
    <div style="font-size:14px;line-height:1.6;color:#404040">${body}</div>
  </div>
</body></html>`;
}
