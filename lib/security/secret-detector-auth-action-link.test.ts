/**
 * SECRET_AUTH_ACTION_LINK_ENABLED tests.
 * 
 * TDD: these tests are written first and should FAIL until implementation.
 * 
 * Covers:
 * - Flag OFF regression (main-identical behavior)
 * - Firebase auth action link parsing
 * - google_api_key exception for auth links
 * - auth_action_link detection
 * - oobCode/apiKey never in logs/errors
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// google_api_key pattern: /AIza[A-Za-z0-9_\-]{35}/i requires 39 chars total
const DUMMY_API_KEY = "AIzaSyDummyKeyForTestingPurposesABC12345"; // 40 chars

let savedFlag: string | undefined;
let savedOrgIds: string | undefined;

beforeEach(() => {
  savedFlag = process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  savedOrgIds = process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  else process.env.SECRET_AUTH_ACTION_LINK_ENABLED = savedFlag;
  if (savedOrgIds === undefined) delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  else process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = savedOrgIds;
});

describe("SECRET_AUTH_ACTION_LINK_ENABLED flag", () => {
  test("defaults to OFF", async () => {
    delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
    const { isSecretAuthActionLinkEnabled } = await import("@/lib/feature-flags");
    expect(isSecretAuthActionLinkEnabled()).toBe(false);
  });

  test("org-scoped with _ORG_IDS", async () => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = "11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222";
    const { isSecretAuthActionLinkEnabledForOrg } = await import("@/lib/feature-flags");
    expect(isSecretAuthActionLinkEnabledForOrg("11111111-1111-1111-1111-111111111111")).toBe(true);
    expect(isSecretAuthActionLinkEnabledForOrg("33333333-3333-3333-3333-333333333333")).toBe(false);
  });

  test("empty _ORG_IDS means all orgs when flag ON", async () => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
    const { isSecretAuthActionLinkEnabledForOrg } = await import("@/lib/feature-flags");
    expect(isSecretAuthActionLinkEnabledForOrg("any-org-id")).toBe(true);
  });
});

describe("FLAG OFF REGRESSION: google_api_key unchanged", () => {
  beforeEach(() => {
    delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  });

  test("Firebase resetPassword link with AIza key is blocked as google_api_key", async () => {
    const { detectSecretInString } = await import("./secret-detector");
    const url = `https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc123&apiKey=${DUMMY_API_KEY}&lang=en`;
    const result = detectSecretInString(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pattern).toBe("google_api_key");
    }
  });

  test("Firebase verifyEmail link with AIza key is blocked as google_api_key", async () => {
    const { detectSecretInString } = await import("./secret-detector");
    const url = `https://example.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=xyz789&apiKey=${DUMMY_API_KEY}`;
    const result = detectSecretInString(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pattern).toBe("google_api_key");
    }
  });

  test("standalone AIza key outside URL is blocked as google_api_key", async () => {
    const { detectSecretInString } = await import("./secret-detector");
    const result = detectSecretInString(`APIキーは${DUMMY_API_KEY}です。`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pattern).toBe("google_api_key");
    }
  });
});

describe("FLAG ON: Firebase auth action link parsing", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("parseFirebaseAuthActionLinks extracts valid auth links", async () => {
    const { parseFirebaseAuthActionLinks } = await import("./secret-detector");
    const text = `リンク: https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=secretCode123&apiKey=${DUMMY_API_KEY}&lang=en`;
    const links = parseFirebaseAuthActionLinks(text);
    expect(links.length).toBe(1);
    expect(links[0].mode).toBe("resetPassword");
    expect(links[0].hasOobCode).toBe(true);
    expect(links[0].hasApiKey).toBe(true);
    expect(links[0].apiKeyValue).toBe(DUMMY_API_KEY);
  });

  test("parseFirebaseAuthActionLinks handles multiple links", async () => {
    const { parseFirebaseAuthActionLinks } = await import("./secret-detector");
    const key1 = "AIzaSyFirstKeyABCDEFGHIJKLMNOPQRSTUVWX";
    const key2 = "AIzaSySecondKeyXYZABCDEFGHIJKLMNOPQRST";
    const text = `
      First: https://app.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=code1&apiKey=${key1}
      Second: https://app.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=code2&apiKey=${key2}
    `;
    const links = parseFirebaseAuthActionLinks(text);
    expect(links.length).toBe(2);
  });

  test("parseFirebaseAuthActionLinks requires oobCode", async () => {
    const { parseFirebaseAuthActionLinks } = await import("./secret-detector");
    const text = `https://app.firebaseapp.com/__/auth/action?mode=resetPassword&apiKey=${DUMMY_API_KEY}`;
    const links = parseFirebaseAuthActionLinks(text);
    expect(links.length).toBe(0);
  });

  test("parseFirebaseAuthActionLinks requires valid mode", async () => {
    const { parseFirebaseAuthActionLinks } = await import("./secret-detector");
    const text = `https://app.firebaseapp.com/__/auth/action?mode=invalidMode&oobCode=code&apiKey=${DUMMY_API_KEY}`;
    const links = parseFirebaseAuthActionLinks(text);
    expect(links.length).toBe(0);
  });

  test("valid modes: resetPassword, verifyEmail, signIn, recoverEmail", async () => {
    const { parseFirebaseAuthActionLinks } = await import("./secret-detector");
    for (const mode of ["resetPassword", "verifyEmail", "signIn", "recoverEmail"]) {
      const text = `https://app.firebaseapp.com/__/auth/action?mode=${mode}&oobCode=code&apiKey=${DUMMY_API_KEY}`;
      const links = parseFirebaseAuthActionLinks(text);
      expect(links.length).toBe(1);
      expect(links[0].mode).toBe(mode);
    }
  });
});

describe("FLAG ON: google_api_key exception", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("AIza key ONLY inside valid auth link is NOT detected as google_api_key", async () => {
    const { detectSecretInString } = await import("./secret-detector");
    const url = `https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc123&apiKey=${DUMMY_API_KEY}&lang=en`;
    const result = detectSecretInString(url);
    expect(result.ok).toBe(true);
  });

  test("AIza key also outside auth link is still blocked as google_api_key", async () => {
    const { detectSecretInString } = await import("./secret-detector");
    const message = `
      リンク: https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc&apiKey=${DUMMY_API_KEY}
      別の場所にも同じキー: ${DUMMY_API_KEY}
    `;
    const result = detectSecretInString(message);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pattern).toBe("google_api_key");
    }
  });

  test("AIza key in different parameter is blocked", async () => {
    const { detectSecretInString } = await import("./secret-detector");
    const url = `https://app.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc&otherKey=${DUMMY_API_KEY}`;
    const result = detectSecretInString(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pattern).toBe("google_api_key");
    }
  });

  test("auth link without oobCode still blocks the AIza key", async () => {
    const { detectSecretInString } = await import("./secret-detector");
    const url = `https://app.firebaseapp.com/__/auth/action?mode=resetPassword&apiKey=${DUMMY_API_KEY}`;
    const result = detectSecretInString(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pattern).toBe("google_api_key");
    }
  });

  test("auth link with invalid mode still blocks the AIza key", async () => {
    const { detectSecretInString } = await import("./secret-detector");
    const url = `https://app.firebaseapp.com/__/auth/action?mode=unknown&oobCode=abc&apiKey=${DUMMY_API_KEY}`;
    const result = detectSecretInString(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pattern).toBe("google_api_key");
    }
  });
});

describe("FLAG ON: auth_action_link detection", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("detects auth_action_link in payload", async () => {
    const { detectAuthActionLink } = await import("./secret-detector");
    const url = `https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc123&apiKey=${DUMMY_API_KEY}`;
    const result = detectAuthActionLink(url);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.mode).toBe("resetPassword");
    }
  });

  test("auth_action_link result never contains oobCode value", async () => {
    const { detectAuthActionLink } = await import("./secret-detector");
    const url = `https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=superSecretCode&apiKey=${DUMMY_API_KEY}`;
    const result = detectAuthActionLink(url);
    expect(result.detected).toBe(true);
    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain("superSecretCode");
  });

  test("auth_action_link result never contains apiKey value", async () => {
    const { detectAuthActionLink } = await import("./secret-detector");
    const url = `https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=code&apiKey=${DUMMY_API_KEY}`;
    const result = detectAuthActionLink(url);
    expect(result.detected).toBe(true);
    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(DUMMY_API_KEY);
  });
});

describe("Production scenario: OnePlace password reset mail.send", () => {
  beforeEach(() => {
    delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  });

  test("FLAG OFF: mail.send with Firebase reset link is blocked as google_api_key", async () => {
    const { detectSecretInPayload } = await import("./secret-detector");
    const payload = {
      tool: "mail.send",
      purpose: "password.reset",
      jobId: "job_oneplace_reset_1",
      args: {
        to: "user@tokyo307inc.com",
        from: "noreply@oneplace.tokyo307inc.com",
        subject: "パスワード再設定",
        body: `
          パスワードを再設定するには、以下のリンクをクリックしてください。
          https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc123def456&apiKey=${DUMMY_API_KEY}&lang=ja
          このリンクは24時間有効です。
        `,
      },
    };
    const result = detectSecretInPayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pattern).toBe("google_api_key");
    }
  });

  test("FLAG ON: mail.send with Firebase reset link passes secret detection", async () => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
    const { detectSecretInPayload } = await import("./secret-detector");
    const payload = {
      tool: "mail.send",
      purpose: "password.reset",
      jobId: "job_oneplace_reset_2",
      args: {
        to: "user@tokyo307inc.com",
        from: "noreply@oneplace.tokyo307inc.com",
        subject: "パスワード再設定",
        body: `
          パスワードを再設定するには、以下のリンクをクリックしてください。
          https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc123def456&apiKey=${DUMMY_API_KEY}&lang=ja
          このリンクは24時間有効です。
        `,
      },
    };
    const result = detectSecretInPayload(payload);
    expect(result.ok).toBe(true);
  });
});

describe("oobCode/apiKey never in audit/log/error", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("error response never contains oobCode", async () => {
    const { buildSecretDetectionErrorResponse, detectSecretInString } = await import("./secret-detector");
    delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
    const url = `https://app.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=secretOobCode123&apiKey=${DUMMY_API_KEY}`;
    const result = detectSecretInString(url);
    if (!result.ok) {
      const response = buildSecretDetectionErrorResponse(result);
      const responseJson = JSON.stringify(response);
      expect(responseJson).not.toContain("secretOobCode123");
      expect(responseJson).not.toContain(DUMMY_API_KEY);
    }
  });

  test("fieldPath never reveals oobCode/apiKey parameter values", async () => {
    const { detectSecretInPayload } = await import("./secret-detector");
    delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
    const payload = {
      args: {
        body: `https://app.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=topSecretCode&apiKey=${DUMMY_API_KEY}`,
      },
    };
    const result = detectSecretInPayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldPath).not.toContain("topSecretCode");
      expect(result.fieldPath).not.toContain("AIzaSyDummy");
    }
  });
});

describe("auth_action_link in payload result", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("detectSecretInPayload returns authActionLinks when present", async () => {
    const { detectSecretInPayload } = await import("./secret-detector");
    const payload = {
      args: {
        body: `リンク: https://app.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=code&apiKey=${DUMMY_API_KEY}`,
      },
    };
    const result = detectSecretInPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authActionLinks).toBeDefined();
      expect(result.authActionLinks?.length).toBe(1);
      expect(result.authActionLinks?.[0].mode).toBe("resetPassword");
      expect(result.authActionLinks?.[0].hasOobCode).toBe(true);
    }
  });

  test("authActionLinks never contains oobCode or apiKey values", async () => {
    const { detectSecretInPayload } = await import("./secret-detector");
    const payload = {
      args: {
        body: `https://app.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=secretCode&apiKey=${DUMMY_API_KEY}`,
      },
    };
    const result = detectSecretInPayload(payload);
    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain("secretCode");
    expect(resultJson).not.toContain(DUMMY_API_KEY);
  });

  test("FLAG OFF: detectSecretInPayload does not return authActionLinks", async () => {
    delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
    const { detectSecretInPayload } = await import("./secret-detector");
    const payload = {
      args: {
        body: `https://app.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=code&apiKey=${DUMMY_API_KEY}`,
      },
    };
    const result = detectSecretInPayload(payload);
    expect(result.ok).toBe(false);
  });
});

describe("edge cases", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("percent-encoded URL is correctly parsed", async () => {
    const { parseFirebaseAuthActionLinks } = await import("./secret-detector");
    const encoded = `https://app.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc%2B123&apiKey=${DUMMY_API_KEY}`;
    const links = parseFirebaseAuthActionLinks(encoded);
    expect(links.length).toBe(1);
    expect(links[0].hasOobCode).toBe(true);
  });

  test("custom Firebase domain is recognized", async () => {
    const { parseFirebaseAuthActionLinks } = await import("./secret-detector");
    const url = `https://auth.oneplace.tokyo307inc.com/__/auth/action?mode=resetPassword&oobCode=code&apiKey=${DUMMY_API_KEY}`;
    const links = parseFirebaseAuthActionLinks(url);
    expect(links.length).toBe(1);
  });

  test("non-Firebase URL with similar params is not recognized", async () => {
    const { parseFirebaseAuthActionLinks } = await import("./secret-detector");
    const url = `https://evil.com/fake?mode=resetPassword&oobCode=code&apiKey=${DUMMY_API_KEY}`;
    const links = parseFirebaseAuthActionLinks(url);
    expect(links.length).toBe(0);
  });

  test("multiple different AIza keys (one in auth, one outside) blocks", async () => {
    const { detectSecretInString } = await import("./secret-detector");
    const key1 = "AIzaSyFirstKeyInAuthLinkABCDEFGHIJKLMNOP";
    const key2 = "AIzaSySecondKeyOutsideLinkXYZ1234567890AB";
    const message = `
      Auth: https://app.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=x&apiKey=${key1}
      Leaked: ${key2}
    `;
    const result = detectSecretInString(message);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pattern).toBe("google_api_key");
    }
  });
});
