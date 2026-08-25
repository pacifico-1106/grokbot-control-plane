import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function encryptionKey(): Buffer {
  const raw = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY?.trim() || "";
  if (raw.length < 32) throw new Error("notification_encryption_key_missing");
  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptNotificationSecrets(value: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptNotificationSecrets(value: string): Record<string, string> {
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error("notification_ciphertext_invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivRaw, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("notification_secrets_invalid");
  }
  return parsed as Record<string, string>;
}
