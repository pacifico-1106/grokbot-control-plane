import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  decryptBytes,
  decryptNotificationSecrets,
  encryptBytes,
  encryptNotificationSecrets,
} from "./crypto";

let savedEncryptionKey: string | undefined;

beforeEach(() => {
  savedEncryptionKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
});

afterEach(() => {
  if (savedEncryptionKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = savedEncryptionKey;
});

describe("tenant notification credential encryption", () => {
  test("round-trips without exposing plaintext", () => {
    process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";
    const secret = { botToken: "123:top-secret", webhookSecret: "webhook-secret" };
    const encrypted = encryptNotificationSecrets(secret);
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(encrypted).not.toContain(secret.botToken);
    expect(decryptNotificationSecrets(encrypted)).toEqual(secret);
  });

  test("refuses a missing encryption key", () => {
    delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
    expect(() => encryptNotificationSecrets({ token: "secret" })).toThrow(
      "notification_encryption_key_missing"
    );
  });

  test("encryptBytes round-trips and is not JSON v1", () => {
    process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";
    const raw = Buffer.from("%PDF-1.4 secret-bytes");
    const enc = encryptBytes(raw);
    expect(enc.startsWith("b1.")).toBe(true);
    expect(enc).not.toContain("secret-bytes");
    expect(decryptBytes(enc).equals(raw)).toBe(true);
  });
});
