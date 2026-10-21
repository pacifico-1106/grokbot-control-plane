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

  test("allows when only aws_secret_key is suspected (auth link apiKey)", () => {
    // aws_secret_key suspected should be ignored when auth links are present
    // (the apiKey in auth links can trigger this pattern)
    const result = evaluateAuthActionLinkPolicy(makeInput({
      secretDetection: {
        ok: true,
        authActionLinks: makeLinks(),
        suspected: [{ pattern: "aws_secret_key", fieldPath: "args.body", length: 40 }],
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("needs_approval");
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
