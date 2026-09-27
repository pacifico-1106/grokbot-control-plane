import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeIdToken,
  generateCodeChallenge,
  generateCodeVerifier,
  googleAuthorizeUrl,
  googleOAuthConfigured,
  signGoogleOAuthState,
  verifyGoogleOAuthState,
} from "./oauth";

const originalClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const originalClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const originalEncryptionKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;

afterEach(() => {
  if (originalClientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  else process.env.GOOGLE_OAUTH_CLIENT_ID = originalClientId;

  if (originalClientSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  else process.env.GOOGLE_OAUTH_CLIENT_SECRET = originalClientSecret;

  if (originalEncryptionKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = originalEncryptionKey;
});

describe("googleOAuthConfigured", () => {
  test("returns false when client ID missing", () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
    expect(googleOAuthConfigured()).toBe(false);
  });

  test("returns false when client secret missing", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    expect(googleOAuthConfigured()).toBe(false);
  });

  test("returns true when both configured", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret-that-is-long-enough";
    expect(googleOAuthConfigured()).toBe(true);
  });

  test("returns false for whitespace-only values", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "   ";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
    expect(googleOAuthConfigured()).toBe(false);
  });
});

describe("PKCE code verifier and challenge", () => {
  test("generateCodeVerifier produces URL-safe base64", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(/^[A-Za-z0-9_-]+$/.test(verifier)).toBe(true);
  });

  test("generateCodeChallenge produces different output than verifier", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    expect(challenge).not.toBe(verifier);
    expect(challenge.length).toBeGreaterThan(0);
  });

  test("same verifier produces same challenge", async () => {
    const verifier = generateCodeVerifier();
    const challenge1 = await generateCodeChallenge(verifier);
    const challenge2 = await generateCodeChallenge(verifier);
    expect(challenge1).toBe(challenge2);
  });
});

describe("OAuth state signing and verification", () => {
  test("sign/verify round-trip succeeds with valid nonce", () => {
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret-that-is-long-enough";
    const input = { orgId: "org-1", employeeId: "emp-1", nonce: "test-nonce" };
    const state = signGoogleOAuthState(input);
    const parsed = verifyGoogleOAuthState(state, "test-nonce");
    expect(parsed).not.toBeNull();
    expect(parsed?.orgId).toBe("org-1");
    expect(parsed?.employeeId).toBe("emp-1");
    expect(parsed?.nonce).toBe("test-nonce");
  });

  test("verify fails with wrong nonce (tamper detection)", () => {
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret-that-is-long-enough";
    const input = { orgId: "org-1", employeeId: "emp-1", nonce: "correct-nonce" };
    const state = signGoogleOAuthState(input);
    const parsed = verifyGoogleOAuthState(state, "wrong-nonce");
    expect(parsed).toBeNull();
  });

  test("verify fails with tampered signature", () => {
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret-that-is-long-enough";
    const input = { orgId: "org-1", employeeId: "emp-1", nonce: "test-nonce" };
    const state = signGoogleOAuthState(input);
    const tamperedState = state.slice(0, -5) + "XXXXX";
    const parsed = verifyGoogleOAuthState(tamperedState, "test-nonce");
    expect(parsed).toBeNull();
  });

  test("verify fails with tampered payload", () => {
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret-that-is-long-enough";
    const input = { orgId: "org-1", employeeId: "emp-1", nonce: "test-nonce" };
    const state = signGoogleOAuthState(input);
    const [, sig] = state.split(".");
    const evilPayload = Buffer.from(
      JSON.stringify({ orgId: "evil-org", employeeId: "emp-1", nonce: "test-nonce", exp: Date.now() + 600000 }),
      "utf8"
    ).toString("base64url");
    const tamperedState = `${evilPayload}.${sig}`;
    const parsed = verifyGoogleOAuthState(tamperedState, "test-nonce");
    expect(parsed).toBeNull();
  });

  test("verify fails with expired state", () => {
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret-that-is-long-enough";
    const expiredPayload = {
      orgId: "org-1",
      employeeId: "emp-1",
      nonce: "test-nonce",
      exp: Date.now() - 1000,
    };
    const encoded = Buffer.from(JSON.stringify(expiredPayload), "utf8").toString("base64url");
    const sig = createHmac("sha256", "test-secret-that-is-long-enough")
      .update(encoded)
      .digest("base64url");
    const state = `${encoded}.${sig}`;
    const parsed = verifyGoogleOAuthState(state, "test-nonce");
    expect(parsed).toBeNull();
  });

  test("verify fails with empty state", () => {
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret-that-is-long-enough";
    expect(verifyGoogleOAuthState("", "nonce")).toBeNull();
  });

  test("verify fails with malformed state (no dot)", () => {
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret-that-is-long-enough";
    expect(verifyGoogleOAuthState("no-dot-here", "nonce")).toBeNull();
  });

  test("state NEVER contains code verifier (PKCE security)", () => {
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret-that-is-long-enough";
    const verifier = generateCodeVerifier();
    const input = { orgId: "org-1", employeeId: "emp-1", nonce: "test-nonce" };
    const state = signGoogleOAuthState(input);

    expect(state).not.toContain(verifier);
    expect(state).not.toContain("codeVerifier");
    expect(state).not.toContain("code_verifier");

    const decoded = Buffer.from(state.split(".")[0], "base64url").toString("utf8");
    expect(decoded).not.toContain(verifier);
    expect(decoded).not.toContain("codeVerifier");

    const parsed = verifyGoogleOAuthState(state, "test-nonce");
    expect(parsed).not.toBeNull();
    expect((parsed as unknown as Record<string, unknown>).codeVerifier).toBeUndefined();
  });
});

describe("googleAuthorizeUrl", () => {
  test("includes required parameters", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
    const url = googleAuthorizeUrl("test-state");
    expect(url).toContain("accounts.google.com");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("state=test-state");
    expect(url).toContain("response_type=code");
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
    expect(url).toContain("calendar.freebusy");
  });

  test("includes PKCE challenge when provided", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    const url = googleAuthorizeUrl("test-state", "test-challenge");
    expect(url).toContain("code_challenge=test-challenge");
    expect(url).toContain("code_challenge_method=S256");
  });

  test("omits PKCE when not provided", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    const url = googleAuthorizeUrl("test-state");
    expect(url).not.toContain("code_challenge");
    expect(url).not.toContain("code_challenge_method");
  });
});

describe("decodeIdToken", () => {
  test("decodes valid JWT payload", () => {
    const payload = { sub: "12345", email: "test@example.com", email_verified: true };
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = "fake-signature";
    const token = `${header}.${body}.${sig}`;
    const decoded = decodeIdToken(token);
    expect(decoded?.sub).toBe("12345");
    expect(decoded?.email).toBe("test@example.com");
  });

  test("returns null for malformed token", () => {
    expect(decodeIdToken("not-a-jwt")).toBeNull();
    expect(decodeIdToken("only.two")).toBeNull();
    expect(decodeIdToken("")).toBeNull();
  });

  test("returns null for invalid base64 payload", () => {
    expect(decodeIdToken("header.!!!invalid!!!.sig")).toBeNull();
  });
});

describe("validateIdToken", () => {
  const { validateIdToken } = require("./oauth");

  test("validates correct token", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    const result = validateIdToken({
      aud: "test-client-id",
      iss: "https://accounts.google.com",
      sub: "12345",
      email: "test@example.com",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(result.valid).toBe(true);
  });

  test("accepts accounts.google.com issuer", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    const result = validateIdToken({
      aud: "test-client-id",
      iss: "accounts.google.com",
      sub: "12345",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(result.valid).toBe(true);
  });

  test("rejects wrong audience", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    const result = validateIdToken({
      aud: "wrong-client-id",
      iss: "https://accounts.google.com",
      sub: "12345",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_audience");
  });

  test("rejects wrong issuer", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    const result = validateIdToken({
      aud: "test-client-id",
      iss: "https://evil.com",
      sub: "12345",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_issuer");
  });

  test("rejects expired token", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    const result = validateIdToken({
      aud: "test-client-id",
      iss: "https://accounts.google.com",
      sub: "12345",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("token_expired");
  });

  test("rejects unverified email", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    const result = validateIdToken({
      aud: "test-client-id",
      iss: "https://accounts.google.com",
      sub: "12345",
      email_verified: false,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("email_not_verified");
  });

  test("rejects missing subject", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    const result = validateIdToken({
      aud: "test-client-id",
      iss: "https://accounts.google.com",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_subject");
  });
});
