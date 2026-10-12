import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decryptCommSecrets, encryptCommSecrets } from "@/lib/comm/secret-crypto";

const KEY = "NOTIFICATION_CONFIG_ENCRYPTION_KEY";
const saved = process.env[KEY];
beforeEach(() => {
  process.env[KEY] = "k".repeat(40);
});
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

const A = { accountId: "ec200000-0000-4000-8000-000000000001", orgId: "ec000000-0000-4000-8000-000000000001" };
const B = { accountId: "ec200000-0000-4000-8000-000000000002", orgId: "ec000000-0000-4000-8000-000000000001" };
const SECRETS = { channelAccessToken: "tok-" + "x".repeat(40), channelSecret: "0123456789abcdef0123456789abcdef" };

describe("comm account secret crypto (AES-256-GCM, AAD = account + org)", () => {
  test("round-trips for the same account and org", () => {
    const c = encryptCommSecrets(A, SECRETS);
    expect(c).toMatch(/^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(decryptCommSecrets(A, c)).toEqual(SECRETS);
  });
  test("ciphertext contains no plaintext and differs each time (random IV)", () => {
    const c1 = encryptCommSecrets(A, SECRETS);
    const c2 = encryptCommSecrets(A, SECRETS);
    expect(c1).not.toBe(c2);
    expect(c1).not.toContain("tok-");
    expect(c1).not.toContain(SECRETS.channelSecret);
  });
  test("a row's ciphertext copied to another account or org does not decrypt", () => {
    const c = encryptCommSecrets(A, SECRETS);
    expect(() => decryptCommSecrets(B, c)).toThrow();
    expect(() => decryptCommSecrets({ ...A, orgId: "ec000000-0000-4000-8000-000000000002" }, c)).toThrow();
  });
  test("tampered ciphertext does not decrypt", () => {
    const c = encryptCommSecrets(A, SECRETS);
    const parts = c.split(".");
    parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
    expect(() => decryptCommSecrets(A, parts.join("."))).toThrow();
  });
  test("v1 (approval-channel format, no AAD) is refused", () => {
    expect(() => decryptCommSecrets(A, "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccc")).toThrow();
  });
  test("missing / short key fails closed", () => {
    process.env[KEY] = "short";
    expect(() => encryptCommSecrets(A, SECRETS)).toThrow("comm_secret_key_missing");
    delete process.env[KEY];
    expect(() => encryptCommSecrets(A, SECRETS)).toThrow("comm_secret_key_missing");
  });
});
