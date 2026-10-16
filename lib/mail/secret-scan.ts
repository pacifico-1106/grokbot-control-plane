/**
 * Secret-scan decoded mail attachments (extracted text, never the raw
 * Base64). Field paths only in the result — no contents, no hashes of contents.
 */
import { detectSecretInString, type SecretDetectionResult } from "@/lib/security/secret-detector";
import type { ResolvedMailAttachment } from "@/lib/mail/attachments";
import { extractMailAttachmentText } from "@/lib/mail/text-extract";

export function scanMailAttachmentsForSecrets(
  attachments: ResolvedMailAttachment[]
): SecretDetectionResult {
  const suspected: NonNullable<Extract<SecretDetectionResult, { ok: true }>["suspected"]> = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const extracted = extractMailAttachmentText(att.kind, att.buffer);
    const nameHit = detectSecretInString(att.filename, { fieldPath: `args.attachments[${i}].filename` });
    if (!nameHit.ok) return nameHit;
    if (nameHit.suspected) suspected.push(...nameHit.suspected);
    if (!extracted.text) continue;
    const bodyHit = detectSecretInString(extracted.text, {
      fieldPath: `args.attachments[${i}].content`,
    });
    if (!bodyHit.ok) return bodyHit;
    if (bodyHit.suspected) suspected.push(...bodyHit.suspected);
  }
  return suspected.length > 0 ? { ok: true, suspected } : { ok: true };
}
