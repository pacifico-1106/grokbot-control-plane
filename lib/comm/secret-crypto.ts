/**
 * Secrets of a per-employee comm account (LINE channel access token / channel
 * secret). AES-256-GCM with the same key as the approval channels
 * (NOTIFICATION_CONFIG_ENCRYPTION_KEY), but version "v2" binds the ciphertext to
 * its row: AAD = "employee_comm_account:<accountId>:<orgId>". A ciphertext copied
 * to another account or org therefore fails to decrypt (the v1 approval-channel
 * format has no AAD and is refused here).
 *
 * Server-only. Values never leave this module except to the adapter that sends.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type CommSecretRow = { accountId: string; orgId: string };

function key(): Buffer {
  const raw = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY?.trim() || "";
  if (raw.length < 32) throw new Error("comm_secret_key_missing");
  return createHash("sha256").update(raw, "utf8").digest();
}

function aad(row: CommSecretRow): Buffer {
  return Buffer.from(`employee_comm_account:${row.accountId}:${row.orgId}`, "utf8");
}

export function encryptCommSecrets(row: CommSecretRow, value: Record<string, string>): string {
  const k = key();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  cipher.setAAD(aad(row));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v2.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

export function decryptCommSecrets(row: CommSecretRow, value: string): Record<string, string> {
  const [version, ivRaw, tagRaw, ctRaw, extra] = String(value || "").split(".");
  if (version !== "v2" || !ivRaw || !tagRaw || !ctRaw || extra !== undefined) throw new Error("comm_secret_ciphertext_invalid");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url"));
  decipher.setAAD(aad(row));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ctRaw, "base64url")), decipher.final()]).toString("utf8");
  const parsed = JSON.parse(plain) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("comm_secret_invalid");
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") throw new Error("comm_secret_invalid");
  }
  return parsed as Record<string, string>;
}
