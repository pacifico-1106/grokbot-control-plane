/**
 * Drop mail attachment bodies from a payload before the generic secret
 * detector walks it. A 690 KiB PDF as Base64 exceeds MAX_SCAN_LENGTH and
 * would false-positive as base64_long_secret. Filenames / MIME stay.
 *
 * Only attachment object fields are omitted — `args.content` is a mail body
 * alias and must still be scanned.
 */
const OMIT_KEYS = new Set(["content", "contentbase64", "bytesbase64", "data"]);

function omitInAttachmentObject(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(rec)) {
    if (OMIT_KEYS.has(key.replace(/[_-]/g, "").toLowerCase())) {
      out[key] = "[omitted:attachment_bytes]";
      continue;
    }
    if (key === "fileRef" && typeof item === "string" && (item.startsWith("data:") || item.length > 4096)) {
      out[key] = "[omitted:attachment_ref]";
      continue;
    }
    out[key] = item;
  }
  return out;
}

function omitAttachmentsArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(omitInAttachmentObject);
}

export function omitMailAttachmentBinary(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const rec = payload as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rec };
  if (Object.prototype.hasOwnProperty.call(rec, "attachments")) {
    out.attachments = omitAttachmentsArray(rec.attachments);
  }
  if (Object.prototype.hasOwnProperty.call(rec, "fileAttachment")) {
    out.fileAttachment = omitInAttachmentObject(rec.fileAttachment);
  }
  if (rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)) {
    const args = rec.args as Record<string, unknown>;
    const nextArgs: Record<string, unknown> = { ...args };
    if (Object.prototype.hasOwnProperty.call(args, "attachments")) {
      nextArgs.attachments = omitAttachmentsArray(args.attachments);
    }
    if (Object.prototype.hasOwnProperty.call(args, "fileAttachment")) {
      nextArgs.fileAttachment = omitInAttachmentObject(args.fileAttachment);
    }
    out.args = nextArgs;
  }
  if (rec.payload && typeof rec.payload === "object" && !Array.isArray(rec.payload)) {
    out.payload = omitMailAttachmentBinary(rec.payload);
  }
  return out;
}
