/**
 * Pin an approved mail.send to exactly what the approver saw.
 *
 * At approval time we store one SHA-256 digest per mail field (every
 * `args.<key>`, top-level `email`, and `conversation.email`). An approved
 * re-invoke (approvalId) must carry the identical set of fields with identical
 * values; any added, removed or changed field is a mismatch (fail-closed).
 *
 * - Digests only: the pin never stores the addresses or text in plaintext
 *   (the approval artifact / snapshot already hold what the card shows).
 * - Full values are hashed, so content beyond the snapshot clip (100k chars)
 *   is pinned too.
 * - Object keys are compared order-independently; arrays keep their order.
 * - `null` and `undefined` both mean "not set".
 * - A request with no mail fields at all (only tool / purpose / jobId /
 *   approvalId) executes the approved mail as-is; nothing new can be
 *   introduced, so this is not a mismatch.
 * - An approval without a readable v1 pin (created before this change) is
 *   rejected: the caller must request a new approval.
 */
import { createHash } from "node:crypto";

export const MAIL_SEND_PIN_VERSION = 1 as const;

export type MailSendPin = {
  v: typeof MAIL_SEND_PIN_VERSION;
  alg: "sha256";
  /** field path (e.g. "args.to", "email", "conversation.email") → hex digest */
  fields: Record<string, string>;
};

export type MailSendPinBody = {
  args?: unknown;
  email?: unknown;
  conversation?: unknown;
};

export type MailSendPinCheck =
  | { ok: true; mode: "exact_match" | "approved_content" }
  | { ok: false; code: "approved_send_pin_missing" }
  | {
      ok: false;
      code: "approved_send_content_mismatch";
      mismatchedFields: string[];
      mismatchCount: number;
    };

const DIGEST_DOMAIN = "staffpass.mail_send_pin.v1";
const MAX_REPORTED_FIELDS = 50;
const MAX_FIELD_NAME_CHARS = 80;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Deterministic JSON: object keys sorted, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((key) => rec[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(rec[key])}`).join(",")}}`;
}

function digestField(field: string, value: unknown): string {
  return createHash("sha256")
    .update(`${DIGEST_DOMAIN}\u0000${field}\u0000${canonicalJson(value)}`)
    .digest("hex");
}

/** Every mail field the request carries, keyed by path. */
export function collectPinnedMailFields(body: MailSendPinBody | null | undefined): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  if (!body) return fields;
  if (isPlainObject(body.args)) {
    for (const key of Object.keys(body.args)) {
      const value = body.args[key];
      if (isSet(value)) fields.set(`args.${key}`, value);
    }
  } else if (isSet(body.args)) {
    // Not an object: still part of what would be sent, so pin it as a whole.
    fields.set("args", body.args);
  }
  if (isSet(body.email)) fields.set("email", body.email);
  if (isPlainObject(body.conversation) && isSet(body.conversation.email)) {
    fields.set("conversation.email", body.conversation.email);
  }
  return fields;
}

export function buildMailSendPin(body: MailSendPinBody | null | undefined): MailSendPin {
  const fields: Record<string, string> = {};
  for (const [field, value] of collectPinnedMailFields(body)) {
    fields[field] = digestField(field, value);
  }
  return { v: MAIL_SEND_PIN_VERSION, alg: "sha256", fields };
}

export function parseMailSendPin(metadata: Record<string, unknown> | null | undefined): MailSendPin | null {
  const raw = metadata?.mailSendPin;
  if (!isPlainObject(raw)) return null;
  if (raw.v !== MAIL_SEND_PIN_VERSION || raw.alg !== "sha256") return null;
  if (!isPlainObject(raw.fields)) return null;
  const fields: Record<string, string> = Object.create(null);
  for (const [field, digest] of Object.entries(raw.fields)) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return null;
    fields[field] = digest;
  }
  return { v: MAIL_SEND_PIN_VERSION, alg: "sha256", fields };
}

function reportableFieldName(field: string): string {
  return field.length <= MAX_FIELD_NAME_CHARS ? field : `${field.slice(0, MAX_FIELD_NAME_CHARS)}…`;
}

/**
 * Check an approved re-invoke against the approval's pin.
 * Fail-closed: no readable pin → approved_send_pin_missing.
 */
export function checkApprovedMailSendPin(input: {
  metadata: Record<string, unknown> | null | undefined;
  body: MailSendPinBody | null | undefined;
}): MailSendPinCheck {
  const pin = parseMailSendPin(input.metadata);
  if (!pin) return { ok: false, code: "approved_send_pin_missing" };

  const requestFields = collectPinnedMailFields(input.body);
  if (requestFields.size === 0) return { ok: true, mode: "approved_content" };

  const mismatched = new Set<string>();
  for (const [field, value] of requestFields) {
    const approvedDigest = Object.prototype.hasOwnProperty.call(pin.fields, field)
      ? pin.fields[field]
      : undefined;
    if (approvedDigest !== digestField(field, value)) mismatched.add(field);
  }
  for (const field of Object.keys(pin.fields)) {
    if (!requestFields.has(field)) mismatched.add(field);
  }
  if (mismatched.size === 0) return { ok: true, mode: "exact_match" };

  const sorted = [...mismatched].sort();
  return {
    ok: false,
    code: "approved_send_content_mismatch",
    mismatchedFields: sorted.slice(0, MAX_REPORTED_FIELDS).map(reportableFieldName),
    mismatchCount: sorted.length,
  };
}
