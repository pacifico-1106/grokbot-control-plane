import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  decryptNotificationSecrets,
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
});
