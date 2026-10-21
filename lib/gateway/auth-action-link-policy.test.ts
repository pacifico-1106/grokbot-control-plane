import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  evaluateAuthActionLinkPolicy,
  buildAuthActionLinkApprovalSummary,
  buildAuthActionLinkArtifactLines,
  type AuthActionLinkPolicyInput,
} from "./auth-action-link-policy";
import type { SecretDetectionResult, DetectedAuthActionLink } from "@/lib/security/secret-detector";

let savedFlag: string | undefined;
let savedOrgIds: string | undefined;

beforeEach(() => {
  savedFlag = process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  savedOrgIds = process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
  delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  else process.env.SECRET_AUTH_ACTION_LINK_ENABLED = savedFlag;
  if (savedOrgIds === undefined) delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  else process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = savedOrgIds;
});

const testOrgId = "11111111-1111-1111-1111-111111111111";

function makeLinks(): DetectedAuthActionLink[] {
  return [{ mode: "resetPassword", hasOobCode: true, hasApiKey: true }];
}

function makeDetection(links?: DetectedAuthActionLink[]): SecretDetectionResult {
  return { ok: true, authActionLinks: links };
}

function makeInput(overrides: Partial<AuthActionLinkPolicyInput> = {}): AuthActionLinkPolicyInput {
  return {
    orgId: testOrgId,
    secretDetection: makeDetection(makeLinks()),
    audience: {
      effectiveAudience: "internal",
      namedRecipients: true,
      destinationMissing: false,
    },
    recipients: {
      toCount: 1,
      ccCount: 0,
      bccCount: 0,
    },
    isChannelPost: false,
    ...overrides,
  };
}

describe("evaluateAuthActionLinkPolicy", () => {
  test("returns allow when no auth links", () => {
    const result = evaluateAuthActionLinkPolicy(makeInput({
      secretDetection: { ok: true },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("allow");
      expect(result.reason).toBe("no_auth_links");
    }
  });

  test("returns needs_approval for internal single recipient", () => {
    const result = evaluateAuthActionLinkPolicy(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok && result.action === "needs_approval") {
      expect(result.action).toBe("needs_approval");
      expect(result.reason).toBe("auth_action_link_internal");
      expect(result.links.length).toBe(1);
    }
  });

  test("blocks external recipient", () => {
    const result = evaluateAuthActionLinkPolicy(makeInput({
      audience: {
        effectiveAudience: "external",
        namedRecipients: true,
        destinationMissing: false,
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("external_recipient");
    }
  });

  test("blocks multiple To recipients", () => {
    const result = evaluateAuthActionLinkPolicy(makeInput({
      recipients: {
        toCount: 2,
        ccCount: 0,
        bccCount: 0,
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("multiple_recipients");
    }
  });

  test("blocks CC recipients", () => {
    const result = evaluateAuthActionLinkPolicy(makeInput({
      recipients: {
        toCount: 1,
        ccCount: 1,
        bccCount: 0,
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("has_cc_or_bcc");
    }
  });

  test("blocks BCC recipients", () => {
    const result = evaluateAuthActionLinkPolicy(makeInput({
      recipients: {
        toCount: 1,
        ccCount: 0,
        bccCount: 1,
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("has_cc_or_bcc");
    }
  });

  test("blocks channel post", () => {
    const result = evaluateAuthActionLinkPolicy(makeInput({
      isChannelPost: true,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("channel_post");
    }
  });

  test("blocks when audience unknown", () => {
    const result = evaluateAuthActionLinkPolicy(makeInput({
      audience: {
        effectiveAudience: "external",
        namedRecipients: false,
        destinationMissing: true,
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("audience_unknown");
    }
  });

  test("blocks when other secrets detected (suspected)", () => {
    // Use a non-aws_secret_key pattern since aws_secret_key is filtered out
    // (it can be triggered by the auth link's apiKey)
    const result = evaluateAuthActionLinkPolicy(makeInput({
      secretDetection: {
        ok: true,
        authActionLinks: makeLinks(),
        suspected: [{ pattern: "base64_long_secret", fieldPath: "args.body", length: 64 }],
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("other_secret_detected");
    }
  });

  test("M1: blocks when aws_secret_key is suspected (not apiKey-matching)", () => {
    // M1: aws_secret_key suspected should NO LONGER be unconditionally ignored.
    // If the secret-detector reports it as suspected, it means it's NOT the
    // auth link's apiKey (the detector already filters those). Block it.
    const result = evaluateAuthActionLinkPolicy(makeInput({
      secretDetection: {
        ok: true,
        authActionLinks: makeLinks(),
        suspected: [{ pattern: "aws_secret_key", fieldPath: "args.body", length: 40 }],
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("other_secret_detected");
    }
  });

  test("FLAG OFF: blocks if auth links present", () => {
    delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
    const result = evaluateAuthActionLinkPolicy(makeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("flag_off");
    }
  });

  test("FLAG OFF: allows if no auth links", () => {
    delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
    const result = evaluateAuthActionLinkPolicy(makeInput({
      secretDetection: { ok: true },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("allow");
    }
  });
});

describe("buildAuthActionLinkApprovalSummary", () => {
  test("builds summary with recipient and mode", () => {
    const summary = buildAuthActionLinkApprovalSummary("user@tokyo307inc.com", "resetPassword");
    expect(summary).toBe("認証リンク（パスワード再設定）を user@tokyo307inc.com さんに渡します。");
  });

  test("summary never contains oobCode or apiKey", () => {
    const summary = buildAuthActionLinkApprovalSummary("user@tokyo307inc.com", "verifyEmail");
    expect(summary).not.toContain("oobCode");
    expect(summary).not.toContain("apiKey");
    expect(summary).not.toContain("AIza");
  });
});

describe("buildAuthActionLinkArtifactLines", () => {
  test("builds lines with masked secrets", () => {
    const lines = buildAuthActionLinkArtifactLines("user@tokyo307inc.com", makeLinks());
    expect(lines.some(l => l.includes("宛先:"))).toBe(true);
    expect(lines.some(l => l.includes("[masked]"))).toBe(true);
    expect(lines.join("\n")).not.toContain("AIza");
  });
});

// ============================================================================
// M1: aws_secret_key / api_key_inline suspected exact match only
// ============================================================================
describe("M1: aws_secret_key suspected は auth link の apiKey と完全一致したときだけ無視", () => {
  // M1: The secret-detector already filters out aws_secret_key suspected that
  // matches the auth link's apiKey value (see secret-detector.ts L510-528).
  // Therefore, any aws_secret_key suspected that reaches the policy evaluation
  // is a DIFFERENT key (not the apiKey from the auth link) and should be blocked.

  test("blocks when any aws_secret_key suspected is present (not filtered by detector)", () => {
    // If aws_secret_key suspected reaches policy evaluation, it means the
    // secret-detector determined it does NOT match the auth link's apiKey.
    // In this case, it should be blocked as other_secret_detected.
    const result = evaluateAuthActionLinkPolicy(makeInput({
      secretDetection: {
        ok: true,
        authActionLinks: [{ mode: "resetPassword", hasOobCode: true, hasApiKey: true }],
        suspected: [
          { pattern: "aws_secret_key", fieldPath: "args.body", length: 40 }
        ],
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("other_secret_detected");
    }
  });

  test("blocks api_key_inline suspected (not filtered by detector)", () => {
    // api_key_inline suspected outside of auth link should block
    const result = evaluateAuthActionLinkPolicy(makeInput({
      secretDetection: {
        ok: true,
        authActionLinks: [{ mode: "resetPassword", hasOobCode: true, hasApiKey: true }],
        suspected: [
          { pattern: "api_key_inline", fieldPath: "args.body", length: 50 }
        ],
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("other_secret_detected");
    }
  });

  test("allows when no suspected secrets (detector filtered apiKey-matching ones)", () => {
    // When secret-detector has already filtered out the apiKey-matching aws_secret_key,
    // no suspected should remain, and the policy should allow.
    const result = evaluateAuthActionLinkPolicy(makeInput({
      secretDetection: {
        ok: true,
        authActionLinks: [{ mode: "resetPassword", hasOobCode: true, hasApiKey: true }],
        // No suspected - detector already filtered the apiKey match
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("needs_approval");
    }
  });
});
