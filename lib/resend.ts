import { Resend } from "resend";
import { escapeHtml, sanitizeEmailSubject } from "@/lib/html-escape";
import { SERVICE_LABEL } from "@/lib/brand";

export type EmailTemplate =
  | "welcome"
  | "trial_started"
  | "trial_ending"
  | "billing_receipt"
  | "approval_requested"
  | "approval_needed"
  | "approval_resolved";

export interface SendEmailInput {
  to: string | string[];
  template: EmailTemplate;
  subject: string;
  html: string;
  text?: string;
  tags?: Array<{ name: string; value: string }>;
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
  const resend = getResend();
  if (!resend) {
    console.info("[resend:stub]", input.template, input.to, subject);
    return { ok: true, id: `stub_${Date.now()}`, stub: true };
  }

  const { data, error } = await resend.emails.send({
    from: getEmailFrom(),
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
