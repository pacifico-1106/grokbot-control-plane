/**
 * mail.send pre-policy preparation: threading headers + attachments.
 * Fail-closed. Does not change draft_only / external-send defaults.
 */
import type { GatewayInvokeRequest } from "@/lib/types";
import {
  parseMailThreading,
  mailProviderIsGmail,
  type MailThreading,
} from "@/lib/mail/headers";
import {
  collectMailAttachmentInputs,
  resolveMailAttachments,
  type MailAttachmentError,
  type ResolvedMailAttachment,
} from "@/lib/mail/attachments";
import { scanMailAttachmentsForSecrets } from "@/lib/mail/secret-scan";
import { gmailReplyHeaders, mailAttachmentMimeParts } from "@/lib/mail/mime";
import type { SecretDetectionResult } from "@/lib/security/secret-detector";

export type PreparedMailSend = {
  ok: true;
  attachments: ResolvedMailAttachment[];
  threading: MailThreading;
  gmail: boolean;
};

export type PrepareMailSendFailure =
  | MailAttachmentError
  | { ok: false; code: string; messageJa: string; field?: string }
  | { ok: false; code: "secret_detected_in_payload"; detection: SecretDetectionResult & { ok: false } };

export async function prepareMailSend(
  body: GatewayInvokeRequest
): Promise<PreparedMailSend | PrepareMailSendFailure> {
  const args =
    body.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {};
  const threading = parseMailThreading(args, body.conversation ?? null);
  if (!threading.ok) return threading;

  const resolved = await resolveMailAttachments(collectMailAttachmentInputs(args));
  if (!resolved.ok) return resolved;

  const secret = scanMailAttachmentsForSecrets(resolved.attachments);
  if (!secret.ok) {
    return { ok: false, code: "secret_detected_in_payload", detection: secret };
  }

  return {
    ok: true,
    attachments: resolved.attachments,
    threading: threading.threading,
    gmail: mailProviderIsGmail(args, body.conversation ?? null) || Boolean(threading.threading.threadId),
  };
}

export function mailSendGmailEnvelope(prepared: PreparedMailSend) {
  return {
    gmail: prepared.gmail,
    headers: prepared.gmail ? gmailReplyHeaders(prepared.threading) : {},
    parts: mailAttachmentMimeParts(prepared.attachments),
  };
}
